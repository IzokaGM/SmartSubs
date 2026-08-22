'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const manifest = require('../src/manifest')
const { createConfiguredManifest } = require('../src/configured-manifest')

test('SmartSubs parity migration preserves the stable addon identity', () => {
  assert.equal(manifest.id, 'community.smartsubs')
  assert.equal(manifest.name, 'SmartSubs')
  assert.equal(manifest.version, '1.0.0')
})

test('configured SmartSubs manifest preserves identity and subtitle resources', () => {
  const configured = createConfiguredManifest('https://smartsubs.example/c/private')

  assert.equal(configured.id, 'community.smartsubs')
  assert.equal(configured.name, 'SmartSubs')
  assert.deepEqual(configured.resources, manifest.resources)
  assert.deepEqual(configured.types, ['movie', 'series'])
})

test('SmartSubs parity migration preserves production Cloudflare resource identity', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.name, 'smartsubs')
  assert.deepEqual(config.kv_namespaces, [{
    binding: 'SMARTSUBS_CACHE',
    id: '4d1aa89065f44614bd7f5b7398f8b5b0'
  }])
  assert.equal(config.queues.producers[0].queue, 'smartsubs-translation')
  assert.equal(config.queues.consumers[0].queue, 'smartsubs-translation')
  assert.deepEqual(config.ratelimits.map(item => item.namespace_id), ['9282001', '9282002'])
  assert.equal(config.durable_objects.bindings[0].name, 'SMARTSUBS_DELIVERY')
  assert.equal(config.migrations[0].tag, 'smartsubs-part4-3-delivery-relay')
})
