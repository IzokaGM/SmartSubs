'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildIndexedPrompt } = require('../src/translator')

test('Part 4.5 requests concise, professional Malaysian TV subtitle style', () => {
  const prompt = buildIndexedPrompt([{ id: 0, text: 'Are you kidding me?' }])
  assert.match(prompt, /natural Malaysian Bahasa Melayu/)
  assert.match(prompt, /professional TV and streaming subtitles/)
  assert.match(prompt, /concise/)
  assert.match(prompt, /conversational wording/)
  assert.match(prompt, /unintended Indonesian phrasing/)
  assert.match(prompt, /Preserve meaning, tone, emotion and character relationships/)
  assert.match(prompt, /context-appropriate pronouns/)
  assert.match(prompt, /at most two lines where practical/)
  assert.match(prompt, /speaker markers and formatting tags/)
})

test('Part 4.5 preserves structured cue ids and appends the input JSON unchanged', () => {
  const items = [
    { id: 17, text: 'Hello, <i>John</i>.' },
    { id: 23, text: '[door closes]\nWait!' }
  ]
  const prompt = buildIndexedPrompt(items)
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
  assert.deepEqual(payload, items)
  assert.match(prompt, /exactly one nonempty translated object per input id/)
  assert.match(prompt, /preserving all ids and original order/)
  assert.match(prompt, /Do not merge, split, omit or add cues/)
})

test('Part 4.5 keeps the fixed prompt instructions compact', () => {
  const promptWithoutCues = buildIndexedPrompt([])
  assert.ok(promptWithoutCues.length < 1100)
})
