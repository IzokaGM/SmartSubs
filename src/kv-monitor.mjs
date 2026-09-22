/** Mobile KV monitor: usage is persisted in the existing Delivery Relay Durable Object,
 * in a separate instance per SmartSubs configuration. No Workers KV is touched here. */
import { normaliseMedia } from './kv-usage.mjs'

const METHODS = ['get', 'put', 'list', 'delete']
const CATEGORIES = ['translation-cache', 'queue-state', 'diagnostics', 'other']
const WINDOW_MS = 7 * 86400000
const DAY_MS = 86400000
const PREFIX = 'kv-monitor:v1:'
const MAX_TEST_MS = 4 * 60 * 60 * 1000
const TEST_PREFIX = 'test:'

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

function freshAggregate(media, date = null) {
  return { media, ...(date ? { date } : {}), requests: 0, attempted: zero(), succeeded: zero(), failed: zero(),
    categories: cleanCategories(null), phases: {}, cacheResults: {}, ids: [], last: 0 }
}

function addToAggregate(next, event) {
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
  return next
}

function testKey(media) { return `${TEST_PREFIX}${media.type}:${media.id}` }

// An explicit manual measurement window. We do not infer a viewing session from
// repeated playback requests (seek and background queue calls are indistinguishable).
export async function controlMonitorTest(storage, action, rawMedia, now = Date.now()) {
  const media = normaliseMedia(rawMedia)
  if (!media || !['start', 'stop', 'reset'].includes(action)) return { status: 400, code: 'invalid' }
  const key = testKey(media)
  const previous = await storage.get(key)
  const active = previous?.status === 'active' && now < previous.startedAt + MAX_TEST_MS
  if (action === 'start') {
    if (active) return { status: 409, code: 'active' }
    const next = { ...freshAggregate(media), startedAt: now, endedAt: null, status: 'active' }
    await storage.put(key, next)
    return { status: 204, code: 'started' }
  }
  if (action === 'reset') {
    await storage.delete(key) // never delete usage: rows, translation cache or queue state
    return { status: 204, code: 'reset' }
  }
  if (!previous) return { status: 404, code: 'missing' }
  if (previous.status === 'active') {
    previous.status = 'stopped'
    previous.endedAt = Math.min(now, previous.startedAt + MAX_TEST_MS)
    await storage.put(key, previous)
  }
  return { status: 204, code: 'stopped' }
}

export async function readMonitorTests(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: TEST_PREFIX })
  const cutoff = now - WINDOW_MS
  return [...rows.values()].filter(row => row?.media && row.startedAt >= cutoff).map(row => ({
    ...row,
    status: row.status === 'active' && now >= row.startedAt + MAX_TEST_MS ? 'stopped' : row.status,
    endedAt: row.endedAt || (now >= row.startedAt + MAX_TEST_MS ? row.startedAt + MAX_TEST_MS : null)
  })).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100)
}

export async function storeMonitorReport(storage, raw) {
  const event = reportForStorage(raw)
  if (!event) return false
  const date = new Date(event.timestamp).toISOString().slice(0, 10)
  const key = `usage:${date}:${event.media.type}:${event.media.id}`
  const previous = await storage.get(key)
  if (previous?.ids?.includes(event.requestId)) return false
  const next = addToAggregate(previous || freshAggregate(event.media, date), event)
  await storage.put(key, next)
  const keyTest = testKey(event.media)
  const test = await storage.get(keyTest)
  if (test?.status === 'active') {
    const receivedAt = Date.now()
    if (receivedAt >= test.startedAt + MAX_TEST_MS) {
      test.status = 'stopped'
      test.endedAt = test.startedAt + MAX_TEST_MS
      await storage.put(keyTest, test)
    } else if (event.timestamp >= test.startedAt && event.timestamp <= receivedAt) {
      // Attribution is by the report's completion timestamp, not by player seek.
      // A late async report is not retroactively added after the test is stopped.
      if (!test.ids?.includes(event.requestId)) {
        addToAggregate(test, event)
        await storage.put(keyTest, test)
      }
    }
  }
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
  const tests = await storage.list({ prefix: TEST_PREFIX })
  for (const [key, test] of tests) {
    if (!test?.startedAt || test.startedAt < now - WINDOW_MS) await storage.delete(key)
  }
  return rows.size > 0 || tests.size > 0
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

function detailView(report, hint) {
  const breakdown = CATEGORIES.map(cat => `<div class="detail"><span>${{ 'translation-cache':'Cache terjemahan', 'queue-state':'Status queue', diagnostics:'Diagnostik', other:'Lain-lain' }[cat]}</span><b>${count(report.categories?.[cat]?.put)} W · ${count(report.categories?.[cat]?.get)} R</b></div>`).join('')
  const phases = Object.entries(report.phases || {}).map(([phase, item]) => `<div class="detail"><span>${escapeHtml(phase)} (${count(item.requests)} permintaan)</span><b>${count(item.attempted?.put)} W · ${count(item.attempted?.get)} R</b></div>`).join('')
  const cache = Object.entries(report.cacheResults || {}).map(([name, qty]) => `${escapeHtml(name)}: ${count(qty)}`).join(' · ') || 'Tiada rekod cache'
  return `${metricsBlock(report.attempted)}<p class="hint">${hint}</p><h3>Punca penggunaan</h3>${breakdown}<h3>Ikut fasa</h3>${phases || '<p class="hint">Belum ada permintaan.</p>'}<h3>Hasil cache</h3><p>${cache}</p><p class="hint">Berjaya: ${count(report.succeeded?.get)} Read / ${count(report.succeeded?.put)} Write · Gagal: ${count(report.failed?.get)} Read / ${count(report.failed?.put)} Write</p>`
}

function testActions(media, test) {
  const fields = `<input type="hidden" name="type" value="${escapeHtml(media.type)}"><input type="hidden" name="id" value="${escapeHtml(media.id)}">`
  const action = test?.status === 'active' ? `<form method="POST" action="kv-monitor/session/stop">${fields}<button type="submit">Tamatkan ujian</button></form>` : `<form method="POST" action="kv-monitor/session/start">${fields}<button type="submit">Mula ujian baharu</button></form>`
  const reset = test ? `<form method="POST" action="kv-monitor/session/reset">${fields}<label class="confirm"><input type="checkbox" name="confirm" value="RESET" required> Sahkan: kosongkan laporan ujian sahaja</label><button class="secondary" type="submit">Reset laporan ujian</button></form>` : ''
  return `<div class="actions">${action}${reset}</div>`
}

function testPanel(media, test) {
  const label = test?.status === 'active' ? 'Ujian sedang berjalan' : 'Ujian terakhir (telah tamat)'
  const date = test?.startedAt ? new Date(test.startedAt).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' }) : ''
  return `<section class="test"><h3>Sesi ujian manual</h3>${test ? `<p><span class="pill">${label}</span> <small>Mula: ${escapeHtml(date)} MYT</small></p><div class="summary"><span>${count(test.requests)} permintaan direkod</span><b>${count(test.attempted?.put)} Write · ${count(test.attempted?.get)} Read</b></div>${detailView(test, 'Hanya permintaan yang sempat direkod semasa tetingkap ujian ini aktif. Seek dikira jika ia mencetuskan permintaan.')}` : '<p class="hint">Belum ada ujian manual untuk episod ini. Tekan Mula sebelum main atau seek.</p>'}${testActions(media, test)}</section>`
}

export function renderKvMonitor(reports, tests = [], notice = '') {
  const byMedia = new Map(tests.map(test => [`${test.media.type}:${test.media.id}`, test]))
  const allMedia = new Map(reports.map(report => [`${report.media.type}:${report.media.id}`, { media: report.media, report }]))
  for (const test of tests) {
    const key = `${test.media.type}:${test.media.id}`
    if (!allMedia.has(key)) allMedia.set(key, { media: test.media, report: null })
  }
  const cards = [...allMedia.values()].sort((a,b) => Math.max(b.report?.last || 0, byMedia.get(`${b.media.type}:${b.media.id}`)?.startedAt || 0) - Math.max(a.report?.last || 0, byMedia.get(`${a.media.type}:${a.media.id}`)?.startedAt || 0)).map(({media, report}) => {
    const test = byMedia.get(`${media.type}:${media.id}`)
    const label = media.type === 'movie' ? 'Filem' : `Siri · Musim ${media.season ?? '?'} · Episod ${media.episode ?? '?'}`
    const total = report || freshAggregate(media)
    return `<details class="card" ${test?.status === 'active' ? 'open' : ''}><summary><small>${escapeHtml(label)}</small><h2>${escapeHtml(media.id)}</h2><div class="summary"><span>${test ? (test.status === 'active' ? 'Ujian aktif' : 'Ujian terakhir tersedia') : 'Belum mula ujian'}</span><b>${count(total.attempted?.put)} Write · ${count(total.attempted?.get)} Read terkumpul</b></div><time>${report?.last ? escapeHtml(new Date(report.last).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' })) : 'Belum ada permintaan'}</time></summary><div class="inside">${testPanel(media, test)}<details class="total"><summary><b>Jumlah episod (semua ujian)</b><p class="hint">${count(total.requests)} permintaan terkumpul · ${count(total.attempted.put)} Write · ${count(total.attempted.get)} Read</p></summary><div class="totalInside">${detailView(total, 'Gabungan semua permintaan episod ini dalam tempoh laporan, termasuk ujian sebelum ini.')}</div></details></div></details>`
  }).join('')
  const messages = { started:'Ujian baharu dimulakan. Sekarang buka episod dan main/seek.', stopped:'Ujian telah ditamatkan. Angka sesi dipisahkan daripada jumlah terkumpul.', reset:'Laporan ujian dikosongkan; jumlah episod dan cache terjemahan kekal.', active:'Ujian episod ini masih aktif. Tamatkan dahulu sebelum mula sesi baharu.', invalid:'Jenis atau ID episod tidak sah.', missing:'Tiada ujian untuk episod ini.', error:'Tindakan tidak berjaya. Cuba sekali lagi.' }
  const notification = messages[notice] ? `<p class="notice">${messages[notice]}</p>` : ''
  return `<!doctype html><html lang="ms"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SmartSubs KV Monitor</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:22px 14px 60px;background:#101419;color:#ecf1f5;font:15px/1.45 system-ui,-apple-system,sans-serif}.wrap{max-width:680px;margin:auto}h1{font-size:25px;margin:0 0 4px}.lead{color:#a3b0bd;margin:0 0 20px}.card{background:#1b232d;border:1px solid #364353;border-radius:15px;margin:10px 0;overflow:hidden}summary{cursor:pointer;padding:16px;list-style:none}summary::-webkit-details-marker{display:none}small{color:#9fb0c2;font-size:12px}h2{font-size:17px;overflow-wrap:anywhere;margin:5px 0 9px}.summary{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.summary b{color:#ffbd68}time{display:block;color:#9fb0c2;font-size:12px;margin-top:8px}.inside{padding:0 16px 17px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.metrics>div{background:#111820;border-radius:9px;padding:10px 5px;text-align:center}.metrics strong{display:block;font-size:21px;margin-top:4px}.detail{display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid #2f3c48}.detail b{white-space:nowrap}.hint{color:#a3b0bd;font-size:12px}h3{font-size:15px;margin:20px 0 5px}.empty{padding:20px;border:1px dashed #465666;border-radius:12px;color:#adbac8}button{background:#2a78e4;color:white;border:0;border-radius:10px;padding:10px 14px;font-weight:650;margin:4px 0 10px}button.secondary{background:#394656}.test{background:#131b24;padding:12px;border-radius:10px;margin:12px 0}.test h3{margin-top:0}.test .metrics{margin-top:14px}.pill{display:inline-block;background:#255c45;color:#c4f8db;border-radius:8px;padding:2px 7px;font-size:12px;margin-right:8px}.actions{margin-top:12px}.actions form{margin:8px 0}.confirm{display:block;font-size:12px;color:#ced7df;margin:7px 0}.confirm input{vertical-align:middle}.total{border-top:1px solid #364353;margin-top:16px}.total>summary{padding:12px 0}.totalInside{padding-bottom:10px}.notice{padding:11px;border:1px solid #3a5c7b;border-radius:10px;background:#1b3043}.newTest{padding:12px;background:#1b232d;border-radius:12px;margin:16px 0}.newTest input,.newTest select{min-height:40px;background:#111820;color:#ecf1f5;border:1px solid #465666;border-radius:8px;padding:8px;margin:3px 4px 3px 0}.newTest input{width:100%;max-width:280px}footer{color:#8a9aaa;font-size:12px;margin-top:22px}</style></head><body><main class="wrap"><h1>SmartSubs KV Monitor</h1><p class="lead">7 hari kalendar termasuk hari ini · Ujian sesi manual & jumlah episod</p>${notification}<form method="GET"><button type="submit">Muat semula</button></form><section class="newTest"><b>Ujian episod baharu</b><p class="hint">Untuk episod yang belum muncul dalam senarai, masukkan ID seperti tt1196946:2:3. Mula sebelum membuka episod.</p><form method="POST" action="kv-monitor/session/start"><select name="type" aria-label="Jenis kandungan"><option value="series">Siri</option><option value="movie">Filem</option></select><input name="id" required maxlength="128" placeholder="ID filem / episod" autocomplete="off"><button type="submit">Mula ujian</button></form></section>${cards || '<div class="empty">Belum ada laporan. Mula ujian dahulu, kemudian buka episod dan muat semula halaman.</div>'}<footer>Setiap ujian bermula apabila tekan Mula dan berakhir apabila tekan Tamat (maksimum 4 jam). Semua permintaan episod yang siap semasa tetingkap itu, termasuk seek, dikira. Ini bukan pengesanan sesi pemain automatik; permintaan lambat atau peranti lain boleh menjejaskan bacaan. Tunggu beberapa saat selepas sari kata siap sebelum tamat ujian. Reset hanya memadam laporan ujian, tidak mengubah jumlah episod, cache terjemahan atau queue. Monitor menggunakan storan Durable Object, bukan Workers KV. Jangan kongsi URL halaman ini kerana ia mengandungi token konfigurasi.</footer></main></body></html>`
}
