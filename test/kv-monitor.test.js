'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createUserConfigToken } = require('../src/user-config')

function mockStorage() {
  const data = new Map()
  let alarm = null
  return {
    async get(key) { return data.get(key) },
    async put(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
    async deleteAll() { data.clear() },
    async list({ prefix, limit } = {}) {
      return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix)).slice(0, limit || Infinity))
    },
    async getAlarm() { return alarm },
    async setAlarm(time) { alarm = time },
    _data: data
  }
}

function snapshot(type, id, phase, counts, requestId = randomUUID()) {
  const categories = {
    'translation-cache': { get: counts.get || 0, put: 0 },
    'queue-state': { get: 0, put: 0 },
    diagnostics: { get: 0, put: counts.put || 0 },
    other: { get: 0, put: 0 }
  }
  return { requestId, timestamp: new Date().toISOString(), phase, media: { type, id },
    attempted: { get: counts.get || 0, put: counts.put || 0 },
    succeeded: { get: counts.get || 0, put: counts.put || 0 },
    failed: { get: 0, put: 0 }, categories }
}

test('Durable Object aggregates requests by episode/day; deduplicates by requestId and keeps stages distinct', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const doStorage = mockStorage()
  const relay = new TranslationDeliveryRelay({ storage: doStorage }, {})
  const a = snapshot('series', 'tt1196946:2:2', 'subtitle-list', { get: 2, put: 4 })
  const b = snapshot('series', 'tt1196946:2:2', 'queue', { get: 3, put: 5 })
  const c = snapshot('series', 'tt1196946:2:1', 'player-translation', { get: 0, put: 2 })
  for (const [index, report] of [a, a, b, c].entries()) {
    const status = (await relay.fetch(new Request('https://internal/usage', {
      method: 'POST', body: JSON.stringify(report)
    }))).status
    assert.equal(status, index === 1 ? 400 : 204)
  }
  const response = await relay.fetch(new Request('https://internal/usage'))
  const rows = await response.json()
  assert.equal(rows.length, 2)
  const s2e2 = rows.find(item => item.media.id === 'tt1196946:2:2')
  assert.equal(s2e2.requests, 2)
  assert.deepEqual([s2e2.attempted.get, s2e2.attempted.put], [5, 9])
  assert.equal(s2e2.phases.queue.requests, 1)
  assert.equal(s2e2.categories.diagnostics.put, 9)
  assert.ok(await doStorage.getAlarm())
})

test('Private monitor reads only configured user reports, and does no Workers KV operation', async () => {
  const { default: worker, TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const { tokenFingerprint } = require('../src/user-config')
  const secret = 'monitor-test-secret'
  const tokenA = createUserConfigToken('a'.repeat(36), { secret })
  const tokenB = createUserConfigToken('b'.repeat(36), { secret })
  const ids = []
  const instances = new Map()
  let kvCalls = 0
  const binding = {
    idFromName(name) { ids.push(name); return name },
    get(id) {
      if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: mockStorage() }, {}))
      return { fetch: (url, init) => instances.get(id).fetch(new Request(url, init)) }
    }
  }
  const kv = { async get() { kvCalls++ }, async put() { kvCalls++ }, async delete() { kvCalls++ }, async list() { kvCalls++ } }
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv, SMARTSUBS_DELIVERY: binding }
  const urlA = `https://smartsubs.test/c/${tokenA}/kv-monitor`
  const urlB = `https://smartsubs.test/c/${tokenB}/kv-monitor`
  assert.equal((await worker.fetch(new Request('https://smartsubs.test/c/bad/kv-monitor'), env)).status, 401)
  const stub = binding.get(binding.idFromName(`kv-monitor:v1:${tokenFingerprint(tokenA)}`))
  await stub.fetch('https://internal/usage', { method: 'POST', body: JSON.stringify(snapshot('movie', 'tt678', 'subtitle-list', { get: 1, put: 3 })) })
  const a = await worker.fetch(new Request(urlA), env)
  const b = await worker.fetch(new Request(urlB), env)
  assert.equal(a.status, 200)
  assert.match(await a.text(), /tt678/)
  assert.doesNotMatch(await b.text(), /tt678/)
  assert.equal(kvCalls, 0)
  assert.ok(ids.some(name => name.startsWith('kv-monitor:v1:')))
})

test('Real player operation is written to monitor asynchronously without extra KV writes', async () => {
  const { default: worker, TranslationDeliveryRelay, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')
  const { tokenFingerprint } = require('../src/user-config')
  const secret = 'monitor-test-secret-2'
  const model = 'model-test'
  const configToken = createUserConfigToken('c'.repeat(35), { secret, model })
  const t = createTranslationToken('https://example.test/source.srt', secret, 'new-cache', { type: 'series', id: 'tt123:1:7' })
  const cacheKey = translationCacheKey(decodeTranslationTokenData(t, secret), model, {})
  const kvCalls = []
  const kv = {
    async get(key, options) { kvCalls.push(['get', key]); if (key === cacheKey && options?.type === 'json') return { v: 1, cacheVersion: 'm8-v1', value: 'WEBVTT\n\nSiap', expiresAt: Date.now() + 60000 }; return null },
    async put(key) { kvCalls.push(['put', key]) }
  }
  const instances = new Map()
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv, SMARTSUBS_DELIVERY: {
    idFromName(name) { return name },
    get(id) { if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: mockStorage() }, {})); return { fetch: (url, init) => instances.get(id).fetch(new Request(url, init)) } }
  } }
  const pending = []
  const ctx = { waitUntil(promise) { pending.push(promise) } }
  const original = console.log
  console.log = () => {}
  let response
  try {
    response = await worker.fetch(new Request(`https://smartsubs.test/c/${configToken}/translated/${t}.vtt`), env, ctx)
    await Promise.all(pending)
  } finally { console.log = original }
  assert.equal(response.status, 200)
  assert.equal(kvCalls.filter(([method]) => method === 'put').length, 2)
  const relay = instances.get(`kv-monitor:v1:${tokenFingerprint(configToken)}`)
  const reports = await (await relay.fetch(new Request('https://internal/usage'))).json()
  assert.equal(reports[0].media.id, 'tt123:1:7')
  assert.equal(reports[0].attempted.put, 2)
  assert.equal(reports[0].attempted.get, 1)
})

test('Mobile page escapes stored media id and shows read/write from queue and diagnostics', async () => {
  const { renderKvMonitor } = await import('../src/kv-monitor.mjs')
  const html = renderKvMonitor([{ media: { type: 'movie', id: '<script>hello</script>' }, requests: 3,
    attempted: { get: 3, put: 6 }, categories: { diagnostics: { get: 0, put: 4 }, 'queue-state': { get: 1, put: 2 } },
    phases: { queue: { requests: 1, attempted: { get: 2, put: 4 } } }, last: Date.now(),
    cacheResults: { MISS: 1 } }])
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>hello/)
  assert.match(html, /6 Write/)
  assert.match(html, /Muat semula/)
})

test('Manual test window isolates seek requests from pre-test and post-test totals, including queue reports', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const relay = new TranslationDeliveryRelay({ storage: mockStorage() }, {})
  const media = { type: 'series', id: 'tt1196946:2:3' }
  const post = (path, value) => relay.fetch(new Request('https://internal' + path, {
    method: 'POST', body: JSON.stringify(value)
  }))
  const first = snapshot('series', media.id, 'subtitle-list', { get: 2, put: 4 })
  assert.equal((await post('/usage', first)).status, 204)
  const start = await post('/usage/session/start', { media })
  assert.equal(start.status, 204)
  assert.equal((await post('/usage/session/start', { media })).status, 409)
  const during = snapshot('series', media.id, 'player-translation', { get: 0, put: 2 })
  assert.equal((await post('/usage', during)).status, 204)
  assert.equal((await post('/usage', during)).status, 400)
  assert.equal((await post('/usage', snapshot('series', media.id, 'queue', { get: 4, put: 3 }))).status, 204)
  const two = await (await relay.fetch(new Request('https://internal/usage?tests=1'))).json()
  const latest = two.tests[0]
  assert.equal(latest.status, 'active')
  assert.deepEqual([latest.requests, latest.attempted.get, latest.attempted.put], [2, 4, 5])
  assert.deepEqual([two.reports[0].requests, two.reports[0].attempted.get, two.reports[0].attempted.put], [3, 6, 9])
  assert.equal((await post('/usage/session/stop', { media })).status, 204)
  assert.equal((await post('/usage', snapshot('series', media.id, 'player-translation', { get: 1, put: 2 }))).status, 204)
  const after = await (await relay.fetch(new Request('https://internal/usage?tests=1'))).json()
  assert.equal(after.tests[0].status, 'stopped')
  assert.deepEqual([after.tests[0].requests, after.tests[0].attempted.put], [2, 5])
  assert.deepEqual([after.reports[0].requests, after.reports[0].attempted.put], [4, 11])
  assert.equal((await post('/usage/session/reset', { media })).status, 204)
  const cleared = await (await relay.fetch(new Request('https://internal/usage?tests=1'))).json()
  assert.equal(cleared.tests.length, 0)
  assert.equal(cleared.reports[0].attempted.put, 11)
  assert.equal((await post('/usage/session/start', { media })).status, 204)
  const next = await (await relay.fetch(new Request('https://internal/usage?tests=1'))).json()
  assert.equal(next.tests[0].requests, 0)
})

test('Monitor session start/stop/reset routes require config token and never touch Workers KV', async () => {
  const { default: worker, TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const secret = 'monitor-session-secret'
  const token = createUserConfigToken('d'.repeat(35), { secret })
  const instances = new Map()
  let kvCalls = 0
  const env = {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {
      async get() { kvCalls++ }, async put() { kvCalls++ },
      async list() { kvCalls++ }, async delete() { kvCalls++ }
    },
    SMARTSUBS_DELIVERY: {
      idFromName(name) { return name },
      get(id) {
        if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: mockStorage() }, {}))
        return { fetch: (url, options) => instances.get(id).fetch(new Request(url, options)) }
      }
    }
  }
  const url = `https://smartsubs.test/c/${token}/kv-monitor`
  const media = new URLSearchParams({ type: 'series', id: 'tt10986410:1:1' })
  const post = (action, body = media, path = url) => worker.fetch(new Request(`${path}/session/${action}`, { method: 'POST', body }), env)
  assert.equal((await post('start', media, 'https://smartsubs.test/c/bad/kv-monitor')).status, 401)
  const started = await post('start')
  assert.equal(started.status, 303)
  assert.equal(new URL(started.headers.get('location')).searchParams.get('notice'), 'started')
  const activeHtml = await (await worker.fetch(new Request(url), env)).text()
  assert.match(activeHtml, /Ujian sedang berjalan/)
  assert.match(activeHtml, /Tamatkan ujian/)
  assert.match(activeHtml, /Jumlah episod \(semua ujian\)/)
  assert.equal(new URL((await post('reset')).headers.get('location')).searchParams.get('notice'), 'invalid')
  const invalidHtml = await (await worker.fetch(new Request(url), env)).text()
  assert.match(invalidHtml, /Ujian sedang berjalan/)
  const reset = new URLSearchParams({ type: 'series', id: 'tt10986410:1:1', confirm: 'RESET' })
  assert.equal(new URL((await post('stop')).headers.get('location')).searchParams.get('notice'), 'stopped')
  assert.equal(new URL((await post('reset', reset)).headers.get('location')).searchParams.get('notice'), 'reset')
  const emptyHtml = await (await worker.fetch(new Request(url), env)).text()
  assert.doesNotMatch(emptyHtml, /Ujian sedang berjalan/)
  assert.equal(kvCalls, 0)
})

test('Old test sessions expire automatically and invalid media cannot be used', async () => {
  const { controlMonitorTest, readMonitorTests, storeMonitorReport, renderKvMonitor } = await import('../src/kv-monitor.mjs')
  const storage = mockStorage()
  const media = { type: 'movie', id: 'tt123' }
  const begin = Date.now() - 5 * 60 * 60 * 1000
  assert.equal((await controlMonitorTest(storage, 'start', media, begin)).status, 204)
  const expired = await readMonitorTests(storage)
  assert.equal(expired[0].status, 'stopped')
  assert.equal(expired[0].endedAt, begin + 4 * 60 * 60 * 1000)
  assert.equal((await controlMonitorTest(storage, 'start', media)).status, 204)
  assert.equal((await controlMonitorTest(storage, 'start', { type: 'series', id: '<script>' })).status, 400)
  const html = renderKvMonitor([], await readMonitorTests(storage))
  assert.match(html, /tt123/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /Reset laporan ujian/)
  assert.match(html, /Ujian episod baharu/)
})
