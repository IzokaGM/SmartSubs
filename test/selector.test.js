import test from "node:test";
import assert from "node:assert/strict";
import { chooseSubtitlePlan, scoreCandidate } from "../src/selector.js";

const mk = (lang, name, id = name) => ({ lang, name, id, url: `https://example.com/${encodeURIComponent(name)}.srt` });

test("matching native Malay wins", () => {
  const extra = { filename: "Silo.S03E02.2160p.WEB-DL.DV.HDR.x265-GROUP.mkv" };
  const plan = chooseSubtitlePlan([
    mk("msa", "Silo.S03E02.2160p.WEB-DL.DV.HDR.x265-GROUP"),
    mk("eng", "Silo.S03E02.2160p.WEB-DL.DV.HDR.x265-GROUP"),
  ], extra);
  assert.equal(plan.mode, "native");
});

test("mismatched Malay loses to matching English", () => {
  const extra = { filename: "Silo.S03E02.2160p.WEB-DL.DV.HDR.x265-GROUP.mkv" };
  const plan = chooseSubtitlePlan([
    mk("msa", "Silo.S03E02.1080p.BluRay.x264-OTHER"),
    mk("eng", "Silo.S03E02.2160p.WEB-DL.DV.HDR.x265-GROUP"),
  ], extra);
  assert.equal(plan.mode, "translate");
  assert.equal(plan.reason, "english-better-match");
});

test("exact hash evidence dominates", () => {
  const hash = "deadbeefcafebabe";
  const strong = scoreCandidate(mk("eng", `Movie.${hash}.WEB-DL`), { filename: "Movie.WEB-DL.mkv", videoHash: hash }, 10);
  const weak = scoreCandidate(mk("eng", "Movie.WEB-DL"), { filename: "Movie.WEB-DL.mkv", videoHash: hash }, 0);
  assert.ok(strong > weak + 100);
});
