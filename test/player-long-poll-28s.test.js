import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('player long-poll waits up to 28s while normal queue concurrency stays 5', async () => {
  const { playerQueueWaitMaxMs, playerQueueGraceMs } = await import('../src/cloudflare-worker.mjs')
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))

  assert.equal(config.vars.PLAYER_QUEUE_WAIT_MAX_MS, '28000')
  assert.equal(config.vars.QUEUE_JOIN_POLL_MS, '1500')
  assert.equal(config.vars.QUEUE_FINAL_CONCURRENCY, '5')
  assert.equal(playerQueueWaitMaxMs(config.vars), 28000)
  assert.equal(playerQueueGraceMs(config.vars), 600)
  assert.equal(playerQueueWaitMaxMs(config.vars) + playerQueueGraceMs(config.vars), 28600)
  assert.equal(playerQueueWaitMaxMs({ PLAYER_QUEUE_WAIT_MAX_MS: 60000 }), 30000)
})
