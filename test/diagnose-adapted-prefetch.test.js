'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveVerdict } = require('../src/diagnostics')

const ts = Date.UTC(2026, 9, 8, 7, 0, 0)
const list = {ts, event:'subtitle-result', type:'series', id:'tt5678:1:2',
  result:'auto-malay-ready', autoReady:true, autoPrefetch:true, malayCount:0,
  englishTrackCount:5, subtitleCount:6, englishSelectedId:'eng-main', englishSourceIds:['eng-main','eng-alt']}

test('V2-styled Diagnose adapts to one primary English source, five English tracks, and background Queue', async () => {
  const {renderConfiguredDiagnosePage} = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('abc',[list,{ts:ts+1000,event:'queue-enqueued',status:'queued'}])
  assert.match(html, /6 tracks/)
  assert.match(html, /1 Malay AI · 5 English/)
  assert.match(html, /Primary English source eng-main/)
  assert.match(html, /<div class="label">Translation<\/div><div class="value">Preparing<\/div><div class="sub">Auto-prefetch \/ Queue running/)
  assert.doesNotMatch(html, /Translation starts only after an AI track is selected/)
  assert.match(html, /Source details/)
})

test('native Malay keeps SmartSubs prefetch OFF and waits until player selects AI', async () => {
  const {renderConfiguredDiagnosePage} = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('abc',[{...list,autoPrefetch:false,malayCount:1,
    subtitleCount:7,result:'native-malay-with-auto-fallback'}])
  assert.match(html,/1 Native Malay/)
  assert.match(html,/Malay AI offered · select in player to translate/)
  assert.doesNotMatch(html, /Auto-prefetch \/ Queue running/)
})

test('verdict reflects a newer failed player translation but does not mask earlier Queue-ready state', () => {
  assert.equal(deriveVerdict([list,{ts:ts+100, event:'queue-translation-complete'}]),'QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION')
  assert.equal(deriveVerdict([list,{ts:ts+100,event:'translation-delivered'},{ts:ts+200,event:'translation-failed'}]), 'TRANSLATION_FAILED')
  assert.equal(deriveVerdict([list,{ts:ts+100,event:'translation-failed'},{ts:ts+200,event:'translation-delivered'}]), 'TRANSLATION_DELIVERED')
})
