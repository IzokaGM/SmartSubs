import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("SmartSubs returns Malay using Nuvio-compatible ms language code", () => {
  assert.equal(source.includes('lang: "Malay"'), false);
  assert.equal(source.includes('lang: "Malay Auto"'), false);

  const matches = source.match(/lang:\s*"ms"/g) || [];
  assert.ok(matches.length >= 2, "expected native and translated Malay tracks to use ms");
});

test("M21 translation profile remains unchanged", () => {
  assert.match(source, /TRANSLATION_CHUNK_SIZE\s*\|\|\s*240/);
  assert.match(source, /TRANSLATION_CONCURRENCY\s*\|\|\s*3/);
  assert.match(source, /m21-context/);
});
