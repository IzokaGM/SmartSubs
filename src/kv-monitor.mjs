/** Mobile KV monitor: usage is persisted in the existing Delivery Relay Durable Object,
 * in a separate instance per SmartSubs configuration. No Workers KV is touched here. */
import { normaliseMedia } from './kv-usage.mjs'

const METHODS = ['get', 'put', 'list', 'delete']
const CATEGORIES = ['translation-cache', 'queue-state', 'diagnostics', 'other']
const WINDOW_MS = 7 * 86400000
const DAY_MS = 86400000
const PREFIX = 'kv-monitor:v1:'

export function monitorStub(env, configId) {
  if (!/^[a-f0-9]{16}$/.test(String(configId || ''))) return null
  const binding = env?.SMARTSUBS_DELIVERY
  if (!binding?.idFromName || !binding?.get) return null
  return binding.get(binding.idFromName(`${PREFIX}${configId}`))
}

const zero = () => ({ get: 0, put: 0, list: 0, delete: 0 })
const cleanCount = counts => Object.fromEntries(METHODS.map(method => [method, Math.max(0, Math.floor(Number(counts?.[method] || 0)) || 0)]))
const plus = (a, b) => Object.fromEntries(METHODS.map(method => [method, (a?.[method] || 0) + (b?.[method] || 0)]))
const cleanCategories = categories => Object.fromEntries(CATEGORIES.map(cat => [cat, cleanCount(categories?.[cat])]))

export function reportForStorage(raw) {
  const media = normaliseMedia(raw?.media)
  const timestamp = Date.parse(raw?.timestamp)
  const requestId = String(raw?.requestId || '')
  if (!media || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > WINDOW_MS ||
      !/^[0-9a-f-]{36}$/i.test(requestId)) return null
  return {
    media, timestamp, requestId,
    phase: ['subtitle-list', 'player-translation', 'queue'].includes(raw.phase) ? raw.phase : 'other',
    cacheResult: String(raw.cacheResult || '').slice(0, 40),
    attempted: cleanCount(raw.attempted), succeeded: cleanCount(raw.succeeded),
    failed: cleanCount(raw.failed), categories: cleanCategories(raw.categories)
  }
}

export async function storeMonitorReport(storage, raw) {
  const event = reportForStorage(raw)
  if (!event) return false
  const date = new Date(event.timestamp).toISOString().slice(0, 10)
  const key = `usage:${date}:${event.media.type}:${event.media.id}`
  const previous = await storage.get(key)
  if (previous?.ids?.includes(event.requestId)) return false
  const next = previous || {
    media: event.media, date, requests: 0, attempted: zero(), succeeded: zero(), failed: zero(),
    categories: cleanCategories(null), phases: {}, cacheResults: {}, ids: [], last: 0
  }
  next.requests++
  next.last = Math.max(next.last, event.timestamp)
  next.attempted = plus(next.attempted, event.attempted)
  next.succeeded = plus(next.succeeded, event.succeeded)
  next.failed = plus(next.failed, event.failed)
  for (const cat of CATEGORIES) next.categories[cat] = plus(next.categories[cat], event.categories[cat])
  const phase = next.phases[event.phase] || { requests: 0, attempted: zero(), failed: zero() }
  phase.requests++
  phase.attempted = plus(phase.attempted, event.attempted)
  phase.failed = plus(phase.failed, event.failed)
  next.phases[event.phase] = phase
  if (event.cacheResult) next.cacheResults[event.cacheResult] = (next.cacheResults[event.cacheResult] || 0) + 1
  next.ids = [...next.ids, event.requestId].slice(-30)
  await storage.put(key, next)
  return true
}

export async function readMonitorReports(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: 'usage:' })
  const cutoff = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 6 * DAY_MS).toISOString().slice(0, 10)
  const reports = new Map()
  for (const report of rows.values()) {
    if (!report || report.date < cutoff) continue
    const id = `${report.media?.type}:${report.media?.id}`
    if (!report.media || !report.requests) continue
    let sum = reports.get(id)
    if (!sum) {
      sum = { media: report.media, requests: 0, attempted: zero(), succeeded: zero(), failed: zero(),
        categories: cleanCategories(null), phases: {}, cacheResults: {}, last: 0 }
      reports.set(id, sum)
    }
    sum.requests += report.requests
    sum.last = Math.max(sum.last, report.last || 0)
    sum.attempted = plus(sum.attempted, report.attempted)
    sum.succeeded = plus(sum.succeeded, report.succeeded)
    sum.failed = plus(sum.failed, report.failed)
    for (const cat of CATEGORIES) sum.categories[cat] = plus(sum.categories[cat], report.categories?.[cat])
    for (const [name, phase] of Object.entries(report.phases || {})) {
      const target = sum.phases[name] || { requests: 0, attempted: zero(), failed: zero() }
      target.requests += phase.requests
      target.attempted = plus(target.attempted, phase.attempted)
      target.failed = plus(target.failed, phase.failed)
      sum.phases[name] = target
    }
    for (const [name, count] of Object.entries(report.cacheResults || {})) sum.cacheResults[name] = (sum.cacheResults[name] || 0) + count
  }
  return [...reports.values()].sort((a, b) => b.last - a.last).slice(0, 100)
}

export async function pruneMonitorReports(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: 'usage:' })
  const cutoff = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 6 * DAY_MS).toISOString().slice(0, 10)
  for (const [key, report] of rows) {
    if (report?.date < cutoff) await storage.delete(key)
  }
  return rows.size > 0
}

export async function publishKvUsage(env, tracker) {
  const stub = monitorStub(env, tracker?.configId)
  if (!stub || !tracker?.media) return false
  const response = await stub.fetch('https://smartsubs-monitor.internal/usage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tracker.snapshot())
  })
  return response.ok
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function count(value) { return Number(value || 0).toLocaleString('en-MY') }
function metricsBlock(counts) {
  return `<div class="metrics">${METHODS.map(method => `<div><small>${{get:'Read',put:'Write',list:'List',delete:'Delete'}[method]}</small><strong>${count(counts?.[method])}</strong></div>`).join('')}</div>`
}

export function renderKvMonitor(reports) {
  const cards = reports.map(report => {
    const label = report.media.type === 'movie' ? 'Filem' : `Siri · Musim ${report.media.season ?? '?'} · Episod ${report.media.episode ?? '?'}`
    const breakdown = CATEGORIES.map(cat => `<div class="detail"><span>${{ 'translation-cache':'Cache terjemahan', 'queue-state':'Status queue', diagnostics:'Diagnostik', other:'Lain-lain' }[cat]}</span><b>${count(report.categories?.[cat]?.put)} W · ${count(report.categories?.[cat]?.get)} R</b></div>`).join('')
    const phases = Object.entries(report.phases || {}).map(([phase, item]) => `<div class="detail"><span>${escapeHtml(phase)} (${count(item.requests)} permintaan)</span><b>${count(item.attempted?.put)} W · ${count(item.attempted?.get)} R</b></div>`).join('')
    const cache = Object.entries(report.cacheResults || {}).map(([name, qty]) => `${escapeHtml(name)}: ${count(qty)}`).join(' · ') || 'Tiada rekod cache'
    return `<details class="card"><summary><small>${escapeHtml(label)}</small><h2>${escapeHtml(report.media.id)}</h2><div class="summary"><span>${count(report.requests)} permintaan direkod</span><b>${count(report.attempted?.put)} Write · ${count(report.attempted?.get)} Read</b></div><time>${escapeHtml(new Date(report.last).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' }))}</time></summary><div class="inside">${metricsBlock(report.attempted)}<p class="hint">Jumlah panggilan KV untuk episod ini sepanjang tempoh laporan; bukan jumlah bagi satu sesi tontonan.</p><h3>Punca penggunaan</h3>${breakdown}<h3>Ikut fasa</h3>${phases}<h3>Hasil cache</h3><p>${cache}</p><p class="hint">Berjaya: ${count(report.succeeded?.get)} Read / ${count(report.succeeded?.put)} Write · Gagal: ${count(report.failed?.get)} Read / ${count(report.failed?.put)} Write</p></div></details>`
  }).join('')
  return `<!doctype html><html lang="ms"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SmartSubs KV Monitor</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:22px 14px 60px;background:#101419;color:#ecf1f5;font:15px/1.45 system-ui,-apple-system,sans-serif}.wrap{max-width:680px;margin:auto}h1{font-size:25px;margin:0 0 4px}.lead{color:#a3b0bd;margin:0 0 20px}.card{background:#1b232d;border:1px solid #364353;border-radius:15px;margin:10px 0;overflow:hidden}summary{cursor:pointer;padding:16px;list-style:none}summary::-webkit-details-marker{display:none}small{color:#9fb0c2;font-size:12px}h2{font-size:17px;overflow-wrap:anywhere;margin:5px 0 9px}.summary{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.summary b{color:#ffbd68}time{display:block;color:#9fb0c2;font-size:12px;margin-top:8px}.inside{padding:0 16px 17px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.metrics>div{background:#111820;border-radius:9px;padding:10px 5px;text-align:center}.metrics strong{display:block;font-size:21px;margin-top:4px}.detail{display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid #2f3c48}.detail b{white-space:nowrap}.hint{color:#a3b0bd;font-size:12px}h3{font-size:15px;margin:20px 0 5px}.empty{padding:20px;border:1px dashed #465666;border-radius:12px;color:#adbac8}button{background:#2a78e4;color:white;border:0;border-radius:10px;padding:10px 14px;font-weight:650;margin:4px 0 10px}footer{color:#8a9aaa;font-size:12px;margin-top:22px}</style></head><body><main class="wrap"><h1>SmartSubs KV Monitor</h1><p class="lead">7 hari kalendar termasuk hari ini · Setiap filem & episod</p><form method="GET"><button type="submit">Muat semula</button></form>${cards || '<div class="empty">Belum ada laporan. Buka episod selepas deploy patch ini, kemudian muat semula halaman.</div>'}<footer>Hanya operasi KV melalui tracker untuk konfigurasi SmartSubs ini. Laporan mula dikumpul selepas patch dipasang dan boleh tertangguh seketika. Operasi Durable Object monitor bukan operasi Workers KV. Jangan kongsi URL halaman ini kerana ia mengandungi token konfigurasi.</footer></main></body></html>`
}
