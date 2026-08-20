export const DIAG_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EVENTS = 50;

const ALLOWED_FIELDS = new Set([
  "type", "id", "result", "error", "cache", "status", "reason", "profile",
  "upstreamCount", "malayCount", "englishCount", "subtitleCount", "englishFound",
  "autoReady", "totalMs", "openSubtitlesMs", "malayScore", "englishScore",
  "expected", "received", "missing", "retryRecovered", "fallbackCount", "final",
  "semanticRetriesUsed", "retries", "chunks", "geminiCalls", "rateLimits",
  "transientRetries", "retryWaitMs", "chunkItems", "chunkChars", "concurrency",
  "attempts", "waitMs", "polls", "joinStatus", "queueDelayMs", "sourceFetchMs",
  "parseMs", "sourceBytes", "cueCount", "pipelineMs", "translationWallMs",
  "chunkTimeline", "maxChunkMs", "avgChunkMs", "sumChunkMs", "geminiCallMs",
  "geminiStatuses", "geminiPromptChars", "failureStage", "retryDelaySeconds",
  "nextAttempt"
]);

export function safeText(value, max = 180) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max);
}

export function sanitiseEvent(event = {}) {
  const output = {
    ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
    event: safeText(event.event, 48),
  };
  for (const key of ALLOWED_FIELDS) {
    const value = event[key];
    if (value === undefined) continue;
    if (typeof value === "boolean" || typeof value === "number") output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 12).map((item) => safeText(item, 48));
    else output[key] = safeText(value);
  }
  return output;
}

export function pruneEvents(events = [], now = Date.now(), limit = MAX_EVENTS) {
  const cutoff = Number(now) - DIAG_TTL_MS;
  return events
    .map((event) => sanitiseEvent(event))
    .filter((event) => event.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, Math.min(MAX_EVENTS, Number(limit) || MAX_EVENTS)));
}

export function deriveVerdict(events = []) {
  const rows = pruneEvents(events);
  const lastSubtitle = rows.find((item) => item.event === "subtitle-result");
  const afterSubtitle = (name, predicate = () => true) => rows.find((item) =>
    item.event === name && predicate(item) && (!lastSubtitle || Number(item.ts) >= Number(lastSubtitle.ts))
  );
  if (!lastSubtitle) return "NO_SUBTITLE_REQUEST_SEEN";
  if (lastSubtitle.result === "native-malay") return "NATIVE_MALAY_RETURNED";
  if (lastSubtitle.result === "error") return "SUBTITLE_REQUEST_FAILED";
  if (Number(lastSubtitle.subtitleCount || 0) === 0) {
    if (lastSubtitle.englishFound === false) return "NO_ENGLISH_SOURCE_FOUND";
    return "SUBTITLE_REQUEST_RETURNED_ZERO";
  }
  if (afterSubtitle("translation-delivered")) return "TRANSLATION_DELIVERED";
  if (afterSubtitle("translation-failed")) return "TRANSLATION_FAILED";
  if (afterSubtitle("queue-join-start")) return "QUEUE_JOIN_WAITING";
  if (afterSubtitle("translation-request", (item) => item.status !== "prefetch")) return "TRANSLATION_REQUESTED_WAITING_FOR_RESULT";
  if (afterSubtitle("queue-translation-complete")) return "QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION";
  if (afterSubtitle("queue-translation-failed")) return "QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION";
  if (afterSubtitle("queue-translation-start")) return "QUEUE_PREFETCH_TRANSLATING";
  if (afterSubtitle("queue-enqueued")) return "QUEUE_PREFETCH_QUEUED";
  if (lastSubtitle.autoReady) return "SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION";
  return "SUBTITLE_RETURNED";
}

function esc(value) {
  return safeText(value, 1000)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metricRows(events) {
  const row = pruneEvents(events).find((item) =>
    ["queue-translation-complete", "translation-delivered", "queue-translation-failed", "translation-failed"].includes(item.event)
  );
  if (!row) return '<div class="muted">No translation performance data yet.</div>';
  const keys = [
    "cache", "totalMs", "queueDelayMs", "sourceFetchMs", "parseMs", "translationWallMs",
    "cueCount", "chunks", "geminiCalls", "geminiCallMs", "geminiPromptChars", "retries",
    "retryRecovered", "maxChunkMs", "avgChunkMs", "concurrency", "failureStage"
  ];
  const cards = keys.filter((key) => row[key] !== undefined).map((key) =>
    `<div class="metric"><span>${esc(key)}</span><strong>${esc(row[key])}</strong></div>`
  ).join("");
  const timeline = Array.isArray(row.chunkTimeline) && row.chunkTimeline.length
    ? `<div class="timeline"><b>chunkTimeline</b><br>${row.chunkTimeline.map(esc).join(" | ")}</div>`
    : "";
  return `<div class="metrics">${cards}</div>${timeline}`;
}

export function renderRootDiagnosePage(buildId, version) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubs Diagnose</title><style>:root{color-scheme:dark}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,sans-serif}.wrap{max-width:760px;margin:auto;padding:28px 18px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:20px}code{word-break:break-all;color:#c9ffdc}</style></head><body><main class="wrap"><section class="card"><h1>SmartSubs Diagnose</h1><p>Version: <code>${esc(version)}</code> | Build: <code>${esc(buildId)}</code></p><p>Open diagnose through your configured SmartSubs URL:</p><code>https://.../c/YOUR_CONFIG_TOKEN/diagnose</code><p>The configured token is required so each installation sees only its own diagnostic stream.</p></section></main></body></html>`;
}

export function renderConfiguredDiagnosePage(configId, events, buildId, version) {
  const clean = pruneEvents(events);
  const verdict = deriveVerdict(clean);
  const rows = clean.map((item) => {
    const time = item.ts > 0 ? new Date(item.ts).toISOString() : "unknown";
    const detail = Object.entries(item)
      .filter(([key]) => !["ts", "event"].includes(key))
      .map(([key, value]) => `${esc(key)}=${esc(Array.isArray(value) ? value.join(",") : value)}`)
      .join(" | ");
    return `<tr><td>${esc(time)}</td><td>${esc(item.event)}</td><td>${detail}</td></tr>`;
  }).join("") || '<tr><td colspan="3">No request events recorded in the last 24 hours.</td></tr>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubs Diagnose</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,sans-serif}.wrap{max-width:1040px;margin:auto;padding:24px 14px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:18px;margin-bottom:14px}.verdict{font-size:20px;font-weight:800;color:#c9ffdc;word-break:break-word}.muted{color:#aeb1bb;font-size:13px}.codes{display:grid;gap:6px;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.metric{background:#111319;border:1px solid #2a2d36;border-radius:10px;padding:10px}.metric span{display:block;color:#aeb1bb;font-size:11px}.metric strong{display:block;margin-top:4px;color:#c9ffdc;word-break:break-word}.timeline{margin-top:10px;font-size:12px;word-break:break-word}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;vertical-align:top;padding:9px;border-bottom:1px solid #30333d;word-break:break-word}th{color:#c7c9d1}code{color:#c9ffdc}</style></head><body><main class="wrap"><section class="card"><h1>SmartSubs Diagnose</h1><div class="verdict">${esc(verdict)}</div><p class="muted">Version ${esc(version)} | Build ${esc(buildId)} | Config ${esc(configId)} | Events kept for up to 24 hours.</p></section><section class="card"><h2>Latest performance</h2>${metricRows(clean)}</section><section class="card"><div class="codes"><div><code>NO_SUBTITLE_REQUEST_SEEN</code>: the configured addon has not been asked for subtitles yet.</div><div><code>NATIVE_MALAY_RETURNED</code>: a strong native Malay match was selected.</div><div><code>NO_ENGLISH_SOURCE_FOUND</code>: no recognised English source was available for Malay Auto.</div><div><code>SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION</code>: Malay Auto was returned and background work has not reported a later state yet.</div><div><code>QUEUE_PREFETCH_QUEUED</code>: translation is queued before player selection.</div><div><code>QUEUE_PREFETCH_TRANSLATING</code>: the Queue consumer is translating now.</div><div><code>QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION</code>: Malay Auto finished before player selection.</div><div><code>QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION</code>: background translation failed and player selection may retry.</div><div><code>QUEUE_JOIN_WAITING</code>: the player selected Malay Auto while the same job was already translating.</div><div><code>TRANSLATION_DELIVERED</code>: translated VTT was returned successfully.</div><div><code>TRANSLATION_FAILED</code>: the player translation request failed.</div></div></section><section class="card"><h2>Recent events</h2><table><thead><tr><th>Time UTC</th><th>Event</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`;
}
