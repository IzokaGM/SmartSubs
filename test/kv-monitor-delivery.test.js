'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const MEDIA = { type: 'series', id: 'tt1196946:2:8' }

async function tracker() {
  const { createKvUsageTracker } = await import('../src/kv-usage.mjs')
  const item = createKvUsageTracker({ phase: 'subtitle-list', media: MEDIA, logger: () => {} })
  item.setConfigId('a'.repeat(16))
  return item
}

function binding(fetchFn) {
  return { SMARTSUBS_DELIVERY: { idFromName: name => name, get: () => ({ fetch: fetchFn }) } }
}

async function withErrors(task) {
  const original = console.error
  const messages = []
  console.error = data => messages.push(JSON.parse(data))
  try { await task(messages) } finally { console.error = original }
}

test('A successful report reaches the configured monitor Durable Object once', async () => {
  const { publishKvUsage } = await import('../src/kv-monitor.mjs')
  const calls = []
  const env = binding(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(null, { status: 204 })
  })
  assert.equal(await publishKvUsage(env, await tracker()), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.media.id, MEDIA.id)
  assert.equal(calls[0].body.phase, 'subtitle-list')
})

test('A transient monitor 503 is retried once without touching Workers KV', async () => {
  const { publishKvUsage } = await import('../src/kv-monitor.mjs')
  let attempts = 0
  const env = binding(async () => new Response(null, { status: ++attempts === 1 ? 503 : 204 }))
  assert.equal(await publishKvUsage(env, await tracker()), true)
  assert.equal(attempts, 2)
  assert.equal('SMARTSUBS_CACHE' in env, false)
})

test('Repeated monitor 503 logs a safe and identifiable error, never a config token', async () => {
  const { publishKvUsage } = await import('../src/kv-monitor.mjs')
  let attempts = 0
  await withErrors(async messages => {
    assert.equal(await publishKvUsage(binding(async () => { attempts++; return new Response(null, { status: 503 }) }), await tracker()), false)
    assert.equal(attempts, 2)
    assert.deepEqual(messages.map(x => x.tag), ['SMARTSUBS_KV_MONITOR_ERROR'])
    assert.equal(messages[0].httpStatus, 503)
    assert.equal(messages[0].reason, 'report-rejected')
    assert.equal(messages[0].configId, 'a'.repeat(16))
    assert.equal(JSON.stringify(messages).includes('/c/'), false)
  })
})

test('Monitor rejects 400 without retry and reports a safe error', async () => {
  const { publishKvUsage } = await import('../src/kv-monitor.mjs')
  let attempts = 0
  await withErrors(async messages => {
    assert.equal(await publishKvUsage(binding(async () => { attempts++; return new Response('invalid', { status: 400 }) }), await tracker()), false)
    assert.equal(attempts, 1)
    assert.equal(messages[0].httpStatus, 400)
  })
})

test('Missing binding and thrown transport failures are logged without throwing', async () => {
  const { publishKvUsage } = await import('../src/kv-monitor.mjs')
  await withErrors(async messages => {
    assert.equal(await publishKvUsage({}, await tracker()), false)
    assert.equal(messages[0].reason, 'missing-monitor-binding')
    let attempts = 0
    const env = binding(async () => { attempts++; throw Error('PRIVATE_CONFIG_TOKEN_EXAMPLE') })
    assert.equal(await publishKvUsage(env, await tracker()), false)
    assert.equal(attempts, 2)
    assert.equal(messages[1].reason, 'monitor-transport-error')
    assert.equal(JSON.stringify(messages).includes('PRIVATE_CONFIG_TOKEN_EXAMPLE'), false)
  })
})

test('Unconfigured requests are not published and do not create noisy errors', async () => {
  const { publishKvUsage } = await import('../src/kv-monitor.mjs')
  await withErrors(async messages => {
    assert.equal(await publishKvUsage({}, null), false)
    assert.equal(await publishKvUsage({}, { media: null }), false)
    assert.equal(messages.length, 0)
  })
})

test('A failed monitor publish never prevents a cached Malay VTT from reaching the player', async () => {
  const { default: worker, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')
  const { createUserConfigToken } = require('../src/user-config')
  const secret = 'a-test-secret'
  const model = 'model-test'
  const configToken = createUserConfigToken('x'.repeat(35), { secret, model })
  const signed = createTranslationToken('https://example.test/source.srt', secret, 'source-cache', MEDIA)
  const key = translationCacheKey(decodeTranslationTokenData(signed, secret), model, {})
  const calls = []
  const kv = {
    async get(k, options) {
      if (k === key && options?.type === 'json') return {
        v: 1, cacheVersion: 'm8-v1', value: 'WEBVTT\\n\\nReady', expiresAt: Date.now() + 60000
      }
      return null
    },
    async put(k) { calls.push(k) }
  }
  let failures = 0
  const env = {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: kv,
    SMARTSUBS_DELIVERY: {
      idFromName: value => value,
      get: () => ({ fetch: async () => { failures++; return new Response(null, { status: 503 }) } })
    }
  }
  const pending = []
  const ctx = { waitUntil(promise) { pending.push(promise) } }
  const originalLog = console.log
  console.log = () => {}
  try {
    await withErrors(async messages => {
      const response = await worker.fetch(new Request(`https://smartsubs.test/c/${configToken}/translated/${signed}.vtt`), env, ctx)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /^WEBVTT/)
      await Promise.all(pending)
      assert.equal(failures, 2)
      assert.equal(messages.at(-1).tag, 'SMARTSUBS_KV_MONITOR_ERROR')
      assert.equal(messages.at(-1).httpStatus, 503)
    })
  } finally { console.log = originalLog }
  // Diagnostic KV operations are unchanged; monitor logging does not itself write to KV.
  assert.equal(calls.length, 2)
})
