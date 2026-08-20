export function parseExtra(extra = "") {
  const decoded = decodeURIComponent(extra || "");
  const params = new URLSearchParams(decoded === "*" ? "" : decoded);
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

export function textOfCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return "";
  const fields = [
    candidate.id,
    candidate.name,
    candidate.fileName,
    candidate.filename,
    candidate.release,
    candidate.url,
    candidate.subFileName,
    candidate.title,
  ];
  return fields.filter(Boolean).join(" ");
}

export function normaliseRelease(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/\b(1080p|2160p|720p|480p|web[ ._-]?dl|webrip|bluray|brrip|hdrip|dvdrip|x26[45]|h\.?26[45]|hevc|av1|hdr10\+?|hdr|dolby[ ._-]?vision|dv|ddp?\d(?:\.\d)?|aac\d(?:\.\d)?)\b/g, " $1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenSet(text = "") {
  return new Set(normaliseRelease(text).split(/\s+/).filter((x) => x.length > 1));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function extractReleaseFacts(text = "") {
  const s = String(text).toLowerCase();
  const pick = (patterns) => patterns.find(([re]) => re.test(s))?.[1] || null;
  return {
    resolution: pick([[/2160p|4k/, "2160p"], [/1080p/, "1080p"], [/720p/, "720p"], [/480p/, "480p"]]),
    source: pick([[/web[ ._-]?dl/, "webdl"], [/webrip/, "webrip"], [/blu[ ._-]?ray|bluray|brrip/, "bluray"], [/hdrip/, "hdrip"], [/dvdrip/, "dvdrip"]]),
    codec: pick([[/x265|h\.?265|hevc/, "hevc"], [/x264|h\.?264|avc/, "avc"], [/\bav1\b/, "av1"]]),
    dynamicRange: pick([[/dolby[ ._-]?vision|\bdv\b/, "dv"], [/hdr10\+/, "hdr10+"], [/\bhdr\b/, "hdr"]]),
  };
}

export async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-allow-methods", "GET,OPTIONS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
