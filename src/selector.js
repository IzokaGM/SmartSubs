import { extractReleaseFacts, jaccard, textOfCandidate, tokenSet } from "./utils.js";

const MALAY_CODES = new Set(["may", "msa", "ms", "mal", "malay"]);
const ENGLISH_CODES = new Set(["eng", "en", "english"]);

function langCode(item) {
  return String(item?.lang || item?.language || "").toLowerCase();
}

export function isMalay(item) {
  return MALAY_CODES.has(langCode(item));
}

export function isEnglish(item) {
  return ENGLISH_CODES.has(langCode(item));
}

function factScore(videoFacts, candidateFacts) {
  let score = 0;
  for (const key of ["resolution", "source", "codec", "dynamicRange"]) {
    if (videoFacts[key] && candidateFacts[key]) score += videoFacts[key] === candidateFacts[key] ? 18 : -14;
  }
  return score;
}

function exactEvidence(candidate, extra) {
  const text = textOfCandidate(candidate).toLowerCase();
  let score = 0;
  const hash = String(extra.videoHash || extra.videohash || "").toLowerCase();
  const size = String(extra.videoSize || extra.videosize || "");
  if (hash && text.includes(hash)) score += 140;
  if (size && text.includes(size)) score += 45;
  return score;
}

export function scoreCandidate(candidate, extra = {}, sourceIndex = 0) {
  const videoName = extra.filename || extra.fileName || extra.name || "";
  const candidateText = textOfCandidate(candidate);
  let score = exactEvidence(candidate, extra);

  if (videoName && candidateText) {
    score += Math.round(jaccard(tokenSet(videoName), tokenSet(candidateText)) * 95);
    score += factScore(extractReleaseFacts(videoName), extractReleaseFacts(candidateText));
  }

  // OpenSubtitles v3 already ranks matches. Preserve a modest bonus for early results
  // when detailed release metadata is absent.
  score += Math.max(0, 24 - sourceIndex * 3);
  return score;
}

export function rankByLanguage(subtitles, predicate, extra = {}) {
  return subtitles
    .map((item, index) => ({ item, index, score: scoreCandidate(item, extra, index) }))
    .filter(({ item }) => predicate(item))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export function chooseSubtitlePlan(subtitles = [], extra = {}) {
  const malay = rankByLanguage(subtitles, isMalay, extra);
  const english = rankByLanguage(subtitles, isEnglish, extra);
  const bestMalay = malay[0] || null;
  const bestEnglish = english[0] || null;

  if (!bestEnglish && bestMalay) return { mode: "native", bestMalay, bestEnglish: null, reason: "no-english" };
  if (!bestMalay && bestEnglish) return { mode: "translate", bestMalay: null, bestEnglish, reason: "no-malay" };
  if (!bestMalay && !bestEnglish) return { mode: "none", bestMalay: null, bestEnglish: null, reason: "no-supported-source" };

  const videoHasReleaseInfo = Boolean(extra.filename || extra.fileName || extra.videoHash || extra.videohash || extra.videoSize || extra.videosize);
  const nativeFloor = videoHasReleaseInfo ? 50 : 22;
  const nativeWins = bestMalay.score >= nativeFloor && bestMalay.score >= bestEnglish.score - 10;

  if (nativeWins) return { mode: "native", bestMalay, bestEnglish, reason: "native-confidence" };
  return { mode: "translate", bestMalay, bestEnglish, reason: "english-better-match" };
}
