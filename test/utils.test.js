import test from "node:test";
import assert from "node:assert/strict";
import { extractReleaseFacts, normaliseRelease, parseExtra, sha256Hex } from "../src/utils.js";

test("parses Stremio extra values", () => {
  const x = parseExtra("filename=Movie.2160p.WEB-DL.mkv&videoHash=abc");
  assert.equal(x.videoHash, "abc");
  assert.match(x.filename, /2160p/);
});

test("extracts release facts", () => {
  assert.deepEqual(extractReleaseFacts("Movie.2160p.WEB-DL.DV.x265"), {
    resolution: "2160p", source: "webdl", codec: "hevc", dynamicRange: "dv",
  });
  assert.match(normaliseRelease("A.WEB-DL.x265"), /web/);
});

test("sha256 is stable", async () => {
  assert.equal((await sha256Hex("abc")).length, 64);
  assert.equal(await sha256Hex("abc"), await sha256Hex("abc"));
});
