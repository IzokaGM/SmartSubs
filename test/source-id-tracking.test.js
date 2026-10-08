'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createTranslationToken } = require('../src/token')
const { createUserConfigToken } = require('../src/user-config')
const { englishSelectionDiagnostics } = require('../src/subtitles')
const { focusDiagnosticsOnLatestSource, deriveVerdict, sanitiseEvent } = require('../src/diagnostics')

const secret = 'safe-source-tracking-secret'
const sourceUrl = 'https://subtitle.invalid/private-english.srt?token=private'
const knownSource = 'source-12345'
const knownToken = createTranslationToken(sourceUrl, secret, knownSource)
const autoUrl = `https://smartsubs.invalid/c/config/translated/${knownToken}.vtt`

const when = Date.UTC(2026, 9, 8, 16, 50, 0)
const subtitle = (sourceId, ts) => ({
  ts, event: 'subtitle-result', type: 'series', id: 'tt123:1:2',
  result: 'auto-malay-ready', subtitleCount: 6, autoReady: true,
  autoPrefetch: true, englishTrackCount: 5, englishSelectedId: sourceId,
  sourceId, englishSourceIds: [sourceId]
})

function parseExport(html) {
  const raw = html.match(/<textarea id="diagnose-export-data" hidden>([\s\S]*?)<\/textarea>/)?.[1]
  assert.ok(raw)
  return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
}

test('Actual subtitle discovery logs the primary Source ID and preserves English track behavior', async () => {
  const { handleSubtitles } = require('../src/subtitles')
  const events = []
  const args = { type: 'series', id: 'tt1234567:1:2' }
  const upstream = [
    { id: knownSource, lang: 'eng', url: sourceUrl },
    { id: 'source-other', lang: 'en', url: 'https://subtitle.invalid/alternate.srt' }
  ]
  const result = await handleSubtitles(args, {
    apiKey: 'dummy', publicBaseUrl: 'https://smartsubs.invalid/c/config', tokenSecret: secret,
    includeEnglishTracks: true, englishTrackLimit: 5,
    fetchImpl: async () => ({ ok: true, json: async () => ({ subtitles: upstream }) }),
    onDiagnostic: event => events.push(event)
  })
  assert.equal(result.subtitles.length, 3)
  assert.deepEqual(result.subtitles.map(track => track.lang), ['msa', 'eng', 'eng'])
  assert.equal(result.subtitles[1].id, `smartsubs-eng-${knownSource}`)
  assert.equal(result.autoPrefetch, true)
  assert.equal(events.find(e => e.event === 'subtitle-result').sourceId, knownSource)

  // With no upstream ID, tracking hashes the URL without changing English track IDs.
  const resultNoId = await handleSubtitles(args, {
    apiKey:'dummy', publicBaseUrl:'https://smartsubs.invalid/c/config', tokenSecret:secret,
    includeEnglishTracks:true,
    fetchImpl: async () => ({ ok:true, json:async () => ({ subtitles:[{ lang:'eng',url:sourceUrl }] }) }),
    onDiagnostic:event => events.push(event)
  })
  assert.equal(resultNoId.subtitles[1].id, 'smartsubs-eng-index-0')
  assert.equal(events.at(-1).sourceId, crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0,12))
  const fileOnly = { file_id: 'file-5432', lang: 'eng', url: sourceUrl }
  assert.equal(englishSelectionDiagnostics([fileOnly], fileOnly).englishSelectedId,
    crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0,12))
})

test('Queue enqueue/consumer reuse exact source ID without changing Queue message schema', async () => {
  const { enqueuePrefetchTranslation, processQueueMessage } = await import('../src/cloudflare-worker.mjs')
  const events = [], messages = []
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: {},
    SMARTSUBS_TRANSLATION_QUEUE: { send: async msg => messages.push(msg) } }
  const configToken = createUserConfigToken('A'.repeat(32), { secret, model: 'gemini-test' })
  assert.equal(await enqueuePrefetchTranslation({ autoUrl, env, configToken, configId: 'id-test',
    diagnosticFn: async (_kv, _id, e) => events.push(e) }), true)
  assert.equal(messages.length, 1)
  assert.equal(Object.hasOwn(messages[0], 'sourceId'), false, 'No Queue payload schema changes')
  await processQueueMessage(messages[0], env, {
    getOrTranslateFn: async () => ({ vtt: 'WEBVTT\n', status: 'MISS',
      translationStats: { geminiCalls: 1, chunks: 1 } }),
    diagnosticFn: async (_kv, _id, e) => events.push(e)
  })
  assert.deepEqual(events.map(e => e.event), [
    'queue-enqueued', 'queue-translation-start', 'queue-translation-complete'
  ])
  for (const event of events) {
    assert.equal(event.sourceId, knownSource)
    assert.doesNotMatch(JSON.stringify(event), /private-english\.srt|private\b/)
  }
})

test('Source without an upstream ID uses identical hashed fallback at discovery and Queue stages', async () => {
  const selected = { url: sourceUrl, lang: 'eng' }
  const selection = englishSelectionDiagnostics([selected], selected)
  const expected = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0,12)
  assert.equal(selection.englishSelectedId, expected)
  const token = createTranslationToken(sourceUrl, secret)
  const events = []
  const { enqueuePrefetchTranslation } = await import('../src/cloudflare-worker.mjs')
  await enqueuePrefetchTranslation({ autoUrl: `https://smartsubs.invalid/translated/${token}.vtt`,
    env: { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: {},
      SMARTSUBS_TRANSLATION_QUEUE: { send: async () => {} } },
    configToken: 'opaque', configId: 'test', diagnosticFn: async (_kv, _id, e) => events.push(e) })
  assert.equal(events[0].sourceId, expected)
  assert.doesNotMatch(JSON.stringify(events), /private-english\.srt|token=private/)
})

test('Diagnostics excludes unrelated source even when its background job finishes later', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const rows = [
    subtitle('source-old', when),
    { ts: when + 100, event: 'queue-enqueued', sourceId: 'source-old' },
    subtitle('source-new', when + 200),
    { ts: when + 300, event: 'queue-enqueued', sourceId: 'source-new' },
    { ts: when + 400, event: 'queue-translation-complete', sourceId: 'source-old', cache: 'MISS' }
  ]
  assert.equal(deriveVerdict(rows), 'QUEUE_PREFETCH_QUEUED')
  const focused = focusDiagnosticsOnLatestSource([...rows].sort((a,b) => b.ts-a.ts))
  assert.equal(focused.some(e => e.sourceId === 'source-old'), false)
  const html = renderConfiguredDiagnosePage('test', rows)
  const data = parseExport(html)
  assert.match(html, /Source journey/)
  assert.match(html, /Source ID <code>source-new<\/code>/)
  assert.equal(data.overview.englishSource, 'source-new')
  assert.deepEqual(data.sourceJourney.map(item => item.stage),
    ['English','Prefetch','Queue','Gemini / Translation','Delivery'])
  assert.equal(data.sourceJourney[2].status, 'Queued')
  assert.equal(data.sourceJourney[3].status, 'Not recorded')
  // Raw event list still preserves real history; the journey is source scoped.
  assert.equal(data.events.length, 5)
})

test('Diagnose traces same ID through completion and delivery, cache HIT skips Gemini', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const events = [
    subtitle(knownSource, when),
    { ts: when+100, event: 'queue-enqueued', sourceId: knownSource },
    { ts: when+200, event: 'queue-translation-start', sourceId: knownSource },
    { ts: when+300, event: 'queue-translation-complete', sourceId: knownSource, cache: 'MISS', geminiCalls: 5 },
    { ts: when+400, event: 'translation-delivered', sourceId: knownSource, cache: 'QUEUE_JOIN', totalMs: 700 }
  ]
  const data = parseExport(renderConfiguredDiagnosePage('test', events))
  assert.equal(data.verdict, 'TRANSLATION_DELIVERED')
  assert.equal(data.sourceJourney[2].status, 'Ready')
  assert.equal(data.sourceJourney[3].status, 'Ready')
  assert.equal(data.sourceJourney[4].status, 'Delivered')
  assert.ok(data.events.every(e => e.sourceId === knownSource))

  const cache = parseExport(renderConfiguredDiagnosePage('test', [subtitle(knownSource,when),
    { ts:when+400,event:'translation-delivered',sourceId:knownSource,cache:'HIT',totalMs:12 }]))
  assert.equal(cache.sourceJourney[3].status, 'Cache hit · no Gemini')
})

test('Direct translation fallback is shown with its Source ID in the journey', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const data = parseExport(renderConfiguredDiagnosePage('test', [
    subtitle(knownSource, when),
    {ts:when+100, event:'translation-direct-start', sourceId:knownSource},
    {ts:when+200, event:'translation-direct-complete', sourceId:knownSource, cache:'MISS', geminiCalls:2},
    {ts:when+300, event:'translation-delivered', sourceId:knownSource, cache:'MISS'}
  ]))
  assert.equal(data.sourceJourney[3].status, 'Ready')
  assert.equal(data.sourceJourney[4].status, 'Delivered')
  assert.equal(data.overview.translationStatus, 'Ready')
})

test('End-to-end cached player delivery logs Source ID when Diagnostics is ON', async () => {
  const { default: worker, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const { decodeTranslationTokenData } = require('../src/token')
  const model = 'gemini-test'
  const configToken = createUserConfigToken('A'.repeat(32), { secret, model })
  const cacheKey = translationCacheKey(decodeTranslationTokenData(knownToken,secret),model,{})
  const stored = []
  const kv = {
    async get(key,opts) {
      if (key === cacheKey && opts?.type === 'json') return { v:1, cacheVersion:'m8-v1',
        value:'WEBVTT\n\nready', expiresAt:Date.now()+60000 }
      return null
    },
    async put(key,value) { stored.push([key, JSON.parse(value)]) }
  }
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv,
    SMARTSUBS_DIAG_ADMIN_KEY: 'separate-admin',
    SMARTSUBS_DELIVERY: { idFromName(name) { return name }, get() {
      return { fetch: async () => Response.json({ enabled: true, since: 0 }) }
    } }
  }
  const response = await worker.fetch(new Request(`https://smartsubs.invalid/c/${configToken}/translated/${knownToken}.vtt`),env,{ waitUntil(){} })
  assert.equal(response.status,200)
  const logged = stored.map(([_,v])=>v)
  assert.deepEqual(logged.map(e => e.event), ['translation-request','translation-delivered'])
  assert.ok(logged.every(e => e.sourceId === knownSource))
})
