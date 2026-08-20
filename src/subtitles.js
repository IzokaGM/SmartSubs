function parseTime(raw) {
  const m = String(raw).trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  return ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function parseSubtitle(text = "") {
  const clean = String(text).replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blocks = clean.replace(/^WEBVTT[^\n]*\n+/i, "").split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((x) => x.trim().length);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [left, rightRaw] = lines[timingIndex].split("-->");
    const right = rightRaw?.trim().split(/\s+/)[0];
    const start = parseTime(left);
    const end = parseTime(right);
    if (start == null || end == null || end < start) continue;
    const body = lines.slice(timingIndex + 1).join("\n").trim();
    if (!body) continue;
    cues.push({ index: cues.length, start, end, text: body });
  }
  return cues;
}

export function toVtt(cues = []) {
  const body = cues.map((cue) => `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.text}`).join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function buildChunks(cues, targetSize = 110, overlap = 5) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const chunks = [];
  for (let start = 0; start < cues.length; start += targetSize) {
    const end = Math.min(cues.length, start + targetSize);
    const contextStart = Math.max(0, start - overlap);
    const contextEnd = Math.min(cues.length, end + overlap);
    chunks.push({
      targetStart: start,
      targetEnd: end,
      cues: cues.slice(contextStart, contextEnd),
      targetIndices: cues.slice(start, end).map((c) => c.index),
    });
  }
  return chunks;
}
