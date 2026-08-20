import { buildChunks, parseSubtitle, toVtt } from "./subtitles.js";
const SYSTEM_PROMPT = `You translate English subtitle dialogue into natural conversational Bahasa Melayu for Malaysian viewers.
Rules:
1. Preserve meaning, tone, humour, slang, names, speaker labels, HTML/SSA tags and line breaks where practical.
2. Do not translate proper names unless Malay normally translates them.
3. Prefer concise spoken Malay that fits subtitle timing. Avoid stiff literal wording.
4. Context cues marked contextOnly help continuity. Do not output them.
5. Return ONLY valid JSON: an array of objects {"i":number,"text":string} for requested target indices, exactly once each.`;
function modelText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

function parseModelJson(text) {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(stripped);
  if (!Array.isArray(value)) throw new Error("Gemini did not return an array");
  return value;
}
async function geminiCall({ apiKey, model, prompt, thinkingLevel = "MINIMAL", onPerf, chunkIndex = 0, attempt = 1 }) {
  const startedAt = Date.now();
  let status = 0;
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel },
        },
      }),
    });
    status = response.status;
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const rows = parseModelJson(modelText(await response.json()));
    onPerf?.({ type: "gemini-call", chunkIndex, attempt, thinkingLevel, status, ok: true, ms: Date.now() - startedAt, promptChars: prompt.length });
    return rows;
  } catch (error) {
    onPerf?.({ type: "gemini-call", chunkIndex, attempt, thinkingLevel, status, ok: false, ms: Date.now() - startedAt, promptChars: prompt.length });
    throw error;
  }
}
function chunkPrompt(chunk) {
  const targets = new Set(chunk.targetIndices);
  return JSON.stringify({
    targetIndices: chunk.targetIndices,
    cues: chunk.cues.map((cue) => ({ i: cue.index, contextOnly: !targets.has(cue.index), text: cue.text })),
  });
}
async function translateChunk(args, chunk, chunkIndex) {
  const startedAt = Date.now();
  let rows;
  let retryUsed = false;
  try {
    rows = await geminiCall({ ...args, prompt: chunkPrompt(chunk), thinkingLevel: "MINIMAL", chunkIndex, attempt: 1 });
  } catch (firstError) {
    retryUsed = true;
    rows = await geminiCall({ ...args, prompt: chunkPrompt(chunk), thinkingLevel: "LOW", chunkIndex, attempt: 2 });
  }
  const wanted = new Set(chunk.targetIndices);
  const out = new Map();
  for (const row of rows) {
    const i = Number(row?.i);
    if (!wanted.has(i) || typeof row?.text !== "string" || !row.text.trim()) continue;
    out.set(i, row.text.trim());
  }
  if (out.size !== wanted.size) throw new Error(`Gemini returned ${out.size}/${wanted.size} translated cues`);
  args.onPerf?.({ type: "chunk-complete", chunkIndex, ms: Date.now() - startedAt, cueCount: wanted.size, retryUsed });
  return out;
}
export async function translateSubtitleText(text, { apiKey, model = "gemini-3.5-flash-lite", concurrency = 3, chunkSize = 110, overlap = 5, onPerf } = {}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const parseStartedAt = Date.now();
  const cues = parseSubtitle(text);
  onPerf?.({ type: "parse-complete", ms: Date.now() - parseStartedAt, cueCount: cues.length });
  if (!cues.length) throw new Error("No subtitle cues were parsed");
  const chunks = buildChunks(cues, chunkSize, overlap);
  const translated = new Map();
  for (let cursor = 0; cursor < chunks.length; cursor += concurrency) {
    const group = chunks.slice(cursor, cursor + concurrency);
    const maps = await Promise.all(group.map((chunk, groupIndex) => translateChunk({ apiKey, model, onPerf }, chunk, cursor + groupIndex)));
    for (const map of maps) for (const [i, value] of map) translated.set(i, value);
  }

  const output = cues.map((cue) => ({ ...cue, text: translated.get(cue.index) || cue.text }));
  onPerf?.({ type: "translation-complete", cueCount: cues.length, chunks: chunks.length });
  return toVtt(output);
}
export async function fetchSubtitleText(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: { "user-agent": "SmartSubs/2.1 (+subtitle translation)" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Subtitle source ${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new Error("Subtitle source was empty");
  return text;
}
