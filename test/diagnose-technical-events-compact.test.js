'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitiseEvent } = require('../src/diagnostics')

const when = (hour, minute = 0, second = 0) => Date.UTC(2026, 9, 6, hour, minute, second)

test('Technical events separate compact Summary and full Raw tabs', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('config', [
    {
      ts: when(4, 50, 50), event: 'subtitle-result', type: 'series', id: 'tt1196946:1:2',
      result: 'auto-malay-ready', subtitleCount: 6, upstreamCount: 91,
      malayCount: 0, englishTrackCount: 5, autoReady: true, autoPrefetch: true,
      englishSelectedId: '4374548', englishSourceIds: ['4374548', '3340583']
    },
    {
      ts: when(4, 51, 20), event: 'queue-translation-complete', sourceId: '4374548',
      cache: 'MISS', totalMs: 26419, geminiCalls: 11, geminiTotalTokensTotal: 79513,
      chunks: 10, missing: 2, retryRecovered: 2
    },
    {
      ts: when(4, 51, 21), event: 'translation-delivered', sourceId: '4374548',
      cache: 'HIT', totalMs: 677, waitMs: 0, polls: 0, joinStatus: 'cache-hit'
    }
  ])

  assert.match(html, /<span class="event-badge good">DELIVERY<\/span>/)
  assert.match(html, /<div class="event-title">Translation delivered<\/div>/)
  assert.match(html, /Source 4374548 · Cache HIT · 677 ms/)
  assert.match(html, /<div class="event-title">Subtitle discovery<\/div>/)
  assert.match(html, /6 tracks · 1 AI Malay · 5 English/)
  assert.match(html, /id="events-summary" checked/)
  assert.match(html, /id="events-raw"/)
  assert.match(html, /for="events-summary">Summary<\/label>/)
  assert.match(html, /for="events-raw">Raw<\/label>/)
  assert.doesNotMatch(html, /Raw details/)
  const summaryPanel = html.match(/<div class="event-tab-panel summary-panel">([\s\S]*?)<\/div><div class="event-tab-panel raw-panel">/)?.[1] || ''
  const rawPanel = html.match(/<div class="event-tab-panel raw-panel">([\s\S]*?)<\/div><\/div><textarea/)?.[1] || ''
  assert.doesNotMatch(summaryPanel, /englishSourceIds/)
  assert.match(rawPanel, /<b>englishSourceIds<\/b>=4374548,3340583/)
  assert.match(html, /<div class="label">English source<\/div><div class="value">4374548<\/div><div class="sub">OpenSubtitles · Auto-selected<\/div>/)
  assert.match(html, /<h2>Technical Events <span class="event-count">3<\/span><\/h2>/)
  assert.doesNotMatch(html, /<details><summary>Technical events/)
  assert.match(html, /<div class="event-toolbar">[\s\S]*?<div class="event-tab-labels">/)
  assert.match(html, />Save Log<\/button>/)
  assert.match(html, />Save Summary<\/button>/)
  assert.match(html, /<summary class="secondary-btn danger-btn">Clear<\/summary>/)
  assert.match(html, /Build final-stable-m20r3 · Malay subtitle delivered · 24h history/)
  assert.match(rawPanel, /Build final-stable-m20r3 · Verdict <code>TRANSLATION_DELIVERED<\/code> · 24-hour history \(MYT\)/)
  assert.match(html, /<b>Selected English<\/b> 4374548/)
})

test('Diagnostic sanitizer keeps selected source ID in the existing event record', () => {
  const clean = sanitiseEvent({
    event: 'translation-delivered', sourceId: '4374548', cache: 'HIT', totalMs: 677
  })
  assert.equal(clean.sourceId, '4374548')
  assert.equal(clean.cache, 'HIT')
  assert.equal(clean.totalMs, 677)
})
