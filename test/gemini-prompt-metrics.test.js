'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildIndexedPrompt, requestGemini, translateCues,
  translateIndexedItems
} = require('../src/translator')
const { sanitiseEvent } = require('../src/diagnostics')

const source = [{ id: 17, text: 'Where is your brother?' }, { id: 18, text: 'He went home.' }]
const responseBody = (translations, finishReason = 'STOP', tokenCount = 54) => ({
  candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ translations }) }] } }],
  usageMetadata: { candidatesTokenCount: tokenCount }
})

test('compact prompt keeps Malaysian Malay, cue integrity and schema while reducing fixed characters', () => {
  const text = buildIndexedPrompt(source)
  const originalFixed = [
    'Translate these English subtitles into natural Malaysian Bahasa Melayu, following professional TV and streaming subtitle style.',
    'Use concise, fluent, conversational Malay. Avoid literal translation, stiff or overly formal language, unintended Indonesian phrasing and unnecessary local slang.',
    'Preserve meaning, tone, emotion and character relationships. Adapt expressions naturally without adding, omitting or softening important meaning.',
    'Keep dialogue short and easy to read. Choose pronouns and vocabulary from context; stay consistent across related cues.',
    'Preserve names, numbers, speaker markers and formatting tags. Use natural line breaks and no more than two lines per cue where practical.',
    'Return exactly one translated object for each input id, preserving all ids and their original order. Do not merge, split, omit or add cues. Output only the required JSON.'
  ].join('\n')
  assert.ok(text.length < originalFixed.length + JSON.stringify(source).length)
  assert.match(text, /Malaysian Bahasa Melayu/)
  assert.match(text, /meaning, tone, emotion/)
  assert.match(text, /speaker markers and formatting tags/)
  assert.match(text, /one nonempty translated object per input id/)
  assert.match(text, /original order/)
  assert.deepEqual(JSON.parse(text.split('\n').at(-1)), source)
})

test('records finish reason and candidate output tokens on successful response without changing Gemini settings', async () => {
  const metrics = {}
  let generationConfig
  const body = responseBody([{ id: 17, text: 'Di mana abang awak?' }])
  const result = await requestGemini(buildIndexedPrompt(source.slice(0, 1)), {
    apiKey: 'fake-test-key', requestMetrics: metrics,
    fetchImpl: async (_url, init) => {
      generationConfig = JSON.parse(init.body).generationConfig
      return { ok: true, status: 200, json: async () => body }
    }
  })
  assert.equal(result, body)
  assert.equal(generationConfig.thinkingConfig.thinkingLevel, 'minimal')
  assert.equal(generationConfig.responseMimeType, 'application/json')
  assert.deepEqual(generationConfig.responseSchema.properties.translations.items.required, ['id', 'text'])
  assert.equal(generationConfig.maxOutputTokens, undefined)
  assert.deepEqual(metrics.geminiStatuses, [200])
  assert.deepEqual(metrics.geminiFinishReasons, ['STOP'])
  assert.deepEqual(metrics.geminiOutputTokens, [54])
})

test('missing metadata, 503 and retry preserve one aligned entry per API attempt', async () => {
  const metrics = {}
  let calls = 0
  await requestGemini('hello', {
    apiKey: 'fake', retries: 1, retryBaseMs: 1, jitterFn: () => 0,
    sleepFn: async () => {}, requestMetrics: metrics,
    fetchImpl: async () => {
      calls++
      return calls === 1
        ? { ok: false, status: 503, headers: { get: () => null } }
        : { ok: true, status: 200, json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"translations":[]}' }] } }]
        }) }
    }
  })
  assert.deepEqual(metrics.geminiStatuses, [503, 200])
  assert.deepEqual(metrics.geminiFinishReasons, ['NA', 'NA'])
  assert.deepEqual(metrics.geminiOutputTokens, ['NA', 'NA'])
  assert.equal(metrics.geminiCallMs.length, 2)
  assert.equal(metrics.geminiPromptChars.length, 2)
})

test('semantic retry retains only missing IDs and captures metadata for each call', async () => {
  const metrics = {}
  const prompts = []
  let calls = 0
  const result = await translateIndexedItems(source, {
    apiKey: 'fake', requestMetrics: metrics,
    fetchImpl: async (_url, init) => {
      const prompt = JSON.parse(init.body).contents[0].parts[0].text
      prompts.push(JSON.parse(prompt.split('\n').at(-1)))
      calls++
      return { ok: true, status: 200, json: async () =>
        calls === 1
          ? responseBody([{ id: 17, text: 'Di mana abang awak?' }], 'STOP', 21)
          : responseBody([{ id: 18, text: 'Dia sudah pulang.' }], 'STOP', 11)
      }
    }
  })
  assert.deepEqual(prompts.map(items => items.map(item => item.id)), [[17, 18], [18]])
  assert.deepEqual(result.translations, ['Di mana abang awak?', 'Dia sudah pulang.'])
  assert.equal(result.stats.retryRecovered, 1)
  assert.deepEqual(metrics.geminiOutputTokens, [21, 11])
})

test('performance snapshot and existing single diagnostic event safely include compact metadata', async () => {
  let result
  const cues = [{ time: '00:00:01.000 --> 00:00:02.000', text: 'Hello' }]
  await translateCues(cues, {
    maxItems: 1, concurrency: 1, apiKey: 'fake',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () =>
      responseBody([{ id: 0, text: 'Hai' }], 'STOP', 9)
    }),
    onTranslationStats: stats => { result = stats }
  })
  assert.deepEqual(result.geminiFinishReasons, ['STOP'])
  assert.deepEqual(result.geminiOutputTokens, [9])
  const diagnostic = sanitiseEvent({
    event: 'queue-translation-complete',
    geminiFinishReasons: result.geminiFinishReasons,
    geminiOutputTokens: result.geminiOutputTokens
  })
  assert.deepEqual(diagnostic.geminiFinishReasons, ['STOP'])
  assert.deepEqual(diagnostic.geminiOutputTokens, ['9'])
  assert.equal(diagnostic.event, 'queue-translation-complete')
  assert.equal(Object.hasOwn(diagnostic, 'translations'), false)
})
