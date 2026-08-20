import test from "node:test";
import assert from "node:assert/strict";
import { buildChunks, parseSubtitle, toVtt } from "../src/subtitles.js";

test("parses SRT and emits VTT", () => {
  const srt = `1\n00:00:01,000 --> 00:00:03,000\nHello.\n\n2\n00:00:04,200 --> 00:00:05,500\nWorld.`;
  const cues = parseSubtitle(srt);
  assert.equal(cues.length, 2);
  assert.match(toVtt(cues), /^WEBVTT/);
  assert.match(toVtt(cues), /00:00:01\.000 --> 00:00:03\.000/);
});

test("context overlap never changes target ownership", () => {
  const cues = Array.from({ length: 250 }, (_, i) => ({ index: i, start: i * 1000, end: i * 1000 + 900, text: String(i) }));
  const chunks = buildChunks(cues, 100, 5);
  assert.deepEqual(chunks.map((c) => c.targetIndices.length), [100, 100, 50]);
  assert.equal(chunks[1].cues[0].index, 95);
  assert.equal(chunks[1].targetIndices[0], 100);
});
