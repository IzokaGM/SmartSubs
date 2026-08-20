import { DurableObject } from "cloudflare:workers";
import { configureHtml, openConfig, sealConfig } from "./config.js";
import { deriveVerdict, MAX_EVENTS, pruneEvents, renderConfiguredDiagnosePage, renderRootDiagnosePage, sanitiseEvent } from "./diagnostics.js";
import { chooseSubtitlePlan, isEnglish, isMalay } from "./selector.js";
import { fetchSubtitleText, translateSubtitleText } from "./translator.js";
import { json, parseExtra, sha256Hex, withCors } from "./utils.js";

const BUILD_ID = "m21.1-diagnose";
const BASE_MANIFEST = {
  id: "org.smartsubs.malay",
  version: "2.1.1",
  name: "SmartSubs",
  description: "Fast Smart Malay subtitles using OpenSubtitles v3 and Gemini.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

function manifest(configured) {
  return {
    ...BASE_MANIFEST,
    behaviorHints: { configurable: true, configurationRequired: !configured },
  };
}
function upstreamBase(env) {
  return String(env.OPENSUBTITLES_V3_URL || "https://opensubtitles-v3.strem.io").replace(/\/$/, "");
}
async function fetchOpenSubtitles(type, id, extra, env) {
  const suffix = extra && extra !== "*" ? `/${extra}` : "";
  const url = `${upstreamBase(env)}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${suffix}.json`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenSubtitles v3 ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.subtitles) ? data.subtitles : [];
}
function stableSourceIdentity(candidate) {
  const url = new URL(candidate.url);
  url.search = "";
  return [candidate.id || "", candidate.lang || "", url.toString()].join("|");
}
async function translationKey(candidate, model) {
  return sha256Hex(`${stableSourceIdentity(candidate)}|${model}|m21-context-v1`);
}
function routeContext(pathname) {
  const configured = pathname.match(/^\/c\/([A-Za-z0-9_-]+)(\/.*)$/);
  if (configured) return { token: configured[1], path: configured[2], configured: true };
  return { token: null, path: pathname, configured: false };
}
async function configFingerprint(token) {
  if (!token) return "";
  return (await sha256Hex(token)).slice(0, 16);
}
function scheduleDiagnostic(env, configId, event, executionCtx) {
  if (!configId || !env.DIAGNOSTICS) return;
  const task = env.DIAGNOSTICS.getByName(configId)
    .record({ ...event, ts: Number(event?.ts || Date.now()) })
    .catch(() => false);
  if (executionCtx && typeof executionCtx.waitUntil === "function") executionCtx.waitUntil(task);
  else void task;
}
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
function failureStage(error) {
  const message = String(error?.message || error || "");
  if (/OpenSubtitles|Subtitle source|No subtitle cues|No timed subtitle cues/i.test(message)) return "source";
  if (/Gemini/i.test(message)) return "gemini";
  if (/translated cues|return an array|JSON/i.test(message)) return "validation";
  if (/Durable Object|storage|cache/i.test(message)) return "cache";
  return "unknown";
}
function translationPerfCollector() {
  const perf = {
    parseMs: 0,
    cueCount: 0,
    chunks: 0,
    geminiCalls: 0,
    geminiCallMs: 0,
    geminiPromptChars: 0,
    geminiStatuses: [],
    chunkTimeline: [],
    chunkMs: [],
    retries: 0,
    retryRecovered: 0,
    rateLimits: 0,
  };
  const onPerf = (event = {}) => {
    if (event.type === "parse-complete") {
      perf.parseMs = Math.max(0, Math.round(Number(event.ms) || 0));
      perf.cueCount = Math.max(0, Number(event.cueCount) || 0);
    } else if (event.type === "gemini-call") {
      perf.geminiCalls += 1;
      perf.geminiCallMs += Math.max(0, Math.round(Number(event.ms) || 0));
      perf.geminiPromptChars += Math.max(0, Number(event.promptChars) || 0);
      perf.geminiStatuses.push(String(event.status || "error"));
      if (Number(event.status) === 429) perf.rateLimits += 1;
      if (Number(event.attempt) > 1) perf.retries += 1;
    } else if (event.type === "chunk-complete") {
      const ms = Math.max(0, Math.round(Number(event.ms) || 0));
      perf.chunkMs.push(ms);
      perf.chunkTimeline.push(`#${Number(event.chunkIndex) + 1}:${ms}ms/${Number(event.cueCount) || 0}`);
      if (event.retryUsed) perf.retryRecovered += 1;
    } else if (event.type === "translation-complete") {
      perf.cueCount = Math.max(perf.cueCount, Number(event.cueCount) || 0);
      perf.chunks = Math.max(0, Number(event.chunks) || 0);
    }
  };
  const summary = () => {
    const sumChunkMs = perf.chunkMs.reduce((sum, value) => sum + value, 0);
    return {
      ...perf,
      sumChunkMs,
      maxChunkMs: perf.chunkMs.length ? Math.max(...perf.chunkMs) : 0,
      avgChunkMs: perf.chunkMs.length ? Math.round(sumChunkMs / perf.chunkMs.length) : 0,
    };
  };
  return { onPerf, summary };
}

async function smartSubtitles(request, env, route, executionCtx) {
  const url = new URL(request.url);
  const match = route.path.match(/^\/subtitles\/(movie|series)\/([^/]+)(?:\/(.*))?\.json$/);
  if (!match) return null;
  if (!route.token && !env.GEMINI_API_KEY) throw new Error("Configure SmartSubs first at /configure");

  const requestStartedAt = Date.now();
  const [, type, encodedId, rawExtra = ""] = match;
  const id = decodeURIComponent(encodedId);
  const extraString = rawExtra || "";
  const extra = parseExtra(extraString);
  const configId = await configFingerprint(route.token);
  scheduleDiagnostic(env, configId, { event: "subtitle-request", type, id }, executionCtx);

  try {
    const config = route.token
      ? await openConfig(route.token, env.CONFIG_SECRET)
      : { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-3.5-flash-lite" };
    const upstreamStartedAt = Date.now();
    const subtitles = await fetchOpenSubtitles(type, id, extraString, env);
    const openSubtitlesMs = Date.now() - upstreamStartedAt;
    const plan = chooseSubtitlePlan(subtitles, extra);
    const malayCount = subtitles.filter(isMalay).length;
    const englishCount = subtitles.filter(isEnglish).length;
    const result = [];

    if (plan.mode === "native" && plan.bestMalay?.item?.url) {
      result.push({ id: `smartsubs-native-${plan.bestMalay.item.id || "ms"}`, url: plan.bestMalay.item.url, lang: "Malay" });
      scheduleDiagnostic(env, configId, {
        event: "subtitle-result",
        result: "native-malay",
        upstreamCount: subtitles.length,
        malayCount,
        englishCount,
        subtitleCount: result.length,
        englishFound: Boolean(plan.bestEnglish),
        autoReady: false,
        malayScore: Number(plan.bestMalay?.score || 0),
        englishScore: Number(plan.bestEnglish?.score || 0),
        reason: plan.reason,
        openSubtitlesMs,
        totalMs: Date.now() - requestStartedAt,
      }, executionCtx);
    } else if (plan.mode === "translate" && plan.bestEnglish?.item?.url) {
      const source = plan.bestEnglish.item;
      const model = config.model || env.GEMINI_MODEL || "gemini-3.5-flash-lite";
      const key = await translationKey(source, model);
      const prefix = route.token ? `/c/${route.token}` : "";
      result.push({ id: `smartsubs-auto-${key.slice(0, 12)}`, url: `${url.origin}${prefix}/vtt/${key}.vtt`, lang: "Malay Auto" });
      const subtitleResultTs = Date.now();
      scheduleDiagnostic(env, configId, {
        ts: subtitleResultTs,
        event: "subtitle-result",
        result: "malay-auto",
        upstreamCount: subtitles.length,
        malayCount,
        englishCount,
        subtitleCount: result.length,
        englishFound: true,
        autoReady: true,
        malayScore: Number(plan.bestMalay?.score || 0),
        englishScore: Number(plan.bestEnglish?.score || 0),
        reason: plan.reason,
        openSubtitlesMs,
        totalMs: subtitleResultTs - requestStartedAt,
      }, executionCtx);
      const job = env.TRANSLATION_JOBS.getByName(key);
      await job.ensure({
        key,
        sourceUrl: source.url,
        model,
        token: route.token || null,
        configId,
        enqueuedAt: Date.now(),
      });
    } else {
      scheduleDiagnostic(env, configId, {
        event: "subtitle-result",
        result: "no-source",
        upstreamCount: subtitles.length,
        malayCount,
        englishCount,
        subtitleCount: 0,
        englishFound: Boolean(plan.bestEnglish),
        autoReady: false,
        reason: plan.reason,
        openSubtitlesMs,
        totalMs: Date.now() - requestStartedAt,
      }, executionCtx);
    }
    return json({ subtitles: result }, { headers: { "cache-control": "public, max-age=30", "x-smartsubs-build": BUILD_ID } });
  } catch (error) {
    scheduleDiagnostic(env, configId, {
      event: "subtitle-result",
      result: "error",
      error: String(error?.message || error),
      failureStage: failureStage(error),
      subtitleCount: 0,
      totalMs: Date.now() - requestStartedAt,
    }, executionCtx);
    throw error;
  }
}

async function translatedVtt(env, route) {
  const match = route.path.match(/^\/vtt\/([a-f0-9]{64})\.vtt$/);
  if (!match) return null;
  const key = match[1];
  const configId = await configFingerprint(route.token);
  const job = env.TRANSLATION_JOBS.getByName(key);
  const vtt = await job.getOrRun(route.token || null, configId);
  return new Response(vtt, {
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-smartsubs-build": BUILD_ID,
    },
  });
}

export class DiagnosticsStore extends DurableObject {
  async record(event) {
    const current = await this.ctx.storage.get("events");
    const events = pruneEvents([sanitiseEvent(event), ...(Array.isArray(current) ? current : [])]);
    await this.ctx.storage.put("events", events);
    return true;
  }
  async read(limit = MAX_EVENTS) {
    const current = await this.ctx.storage.get("events");
    const events = pruneEvents(Array.isArray(current) ? current : [], Date.now(), limit);
    if (Array.isArray(current) && events.length !== current.length) await this.ctx.storage.put("events", events);
    return events;
  }
  async verdict() {
    return deriveVerdict(await this.read());
  }
}

export class TranslationJob extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.inflight = null;
  }
  async ensure(payload) {
    const cached = await this.ctx.storage.get("vtt");
    if (cached) {
      scheduleDiagnostic(this.env, payload.configId, {
        event: "queue-translation-complete",
        cache: "HIT",
        status: "ready",
        totalMs: 0,
      }, this.ctx);
      return { status: "ready" };
    }
    await this.ctx.storage.put("payload", payload);
    const status = await this.ctx.storage.get("status");
    if (status !== "queued" && status !== "running") {
      await this.ctx.storage.put("status", "queued");
      await this.env.TRANSLATION_QUEUE.send(payload);
      scheduleDiagnostic(this.env, payload.configId, {
        event: "queue-enqueued",
        status: "queued",
      }, this.ctx);
      return { status: "queued" };
    }
    scheduleDiagnostic(this.env, payload.configId, {
      event: "queue-enqueued",
      status: String(status || "queued"),
      reason: "existing-job",
    }, this.ctx);
    return { status: String(status || "queued") };
  }
  async getOrRun(requestToken = null, requestConfigId = "") {
    const startedAt = Date.now();
    scheduleDiagnostic(this.env, requestConfigId, { event: "translation-request", status: "player" }, this.ctx);
    const cached = await this.ctx.storage.get("vtt");
    if (cached) {
      scheduleDiagnostic(this.env, requestConfigId, {
        event: "translation-delivered",
        cache: "HIT",
        status: "ready",
        totalMs: Date.now() - startedAt,
        waitMs: 0,
        joinStatus: "cache-hit",
      }, this.ctx);
      return cached;
    }
    const payload = await this.ctx.storage.get("payload");
    if (!payload) throw new Error("Translation job payload is missing");
    if (requestToken && !payload.token) payload.token = requestToken;
    if (requestConfigId && !payload.configId) payload.configId = requestConfigId;
    const status = await this.ctx.storage.get("status");
    const joining = status === "running" || Boolean(this.inflight);
    if (joining) scheduleDiagnostic(this.env, requestConfigId, { event: "queue-join-start", status: "running" }, this.ctx);
    try {
      const vtt = await this.run(payload, "player");
      scheduleDiagnostic(this.env, requestConfigId, {
        event: "translation-delivered",
        cache: joining ? "QUEUE_JOIN" : "MISS",
        status: "ready",
        totalMs: Date.now() - startedAt,
        waitMs: joining ? Date.now() - startedAt : 0,
        joinStatus: joining ? "queue-join" : "direct",
      }, this.ctx);
      return vtt;
    } catch (error) {
      scheduleDiagnostic(this.env, requestConfigId, {
        event: "translation-failed",
        status: "failed",
        error: String(error?.message || error),
        failureStage: failureStage(error),
        totalMs: Date.now() - startedAt,
      }, this.ctx);
      throw error;
    }
  }
  async run(payload, origin = "player") {
    const cached = await this.ctx.storage.get("vtt");
    if (cached) {
      if (origin === "queue") {
        scheduleDiagnostic(this.env, payload.configId, {
          event: "queue-translation-complete",
          cache: "HIT",
          status: "ready",
          totalMs: 0,
        }, this.ctx);
      }
      return cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const pipelineStartedAt = Date.now();
      await this.ctx.storage.put("status", "running");
      if (origin === "queue") {
        scheduleDiagnostic(this.env, payload.configId, {
          event: "queue-translation-start",
          status: "consumer",
          profile: "m21-context",
          attempts: Number(payload.attempts || 1),
          queueDelayMs: payload.enqueuedAt ? Math.max(0, Date.now() - Number(payload.enqueuedAt)) : 0,
          chunkItems: Number(this.env.TRANSLATION_CHUNK_SIZE || 240),
          concurrency: Number(this.env.TRANSLATION_CONCURRENCY || 3),
        }, this.ctx);
      }
      try {
        const config = payload.token
          ? await openConfig(payload.token, this.env.CONFIG_SECRET)
          : { apiKey: this.env.GEMINI_API_KEY, model: payload.model || this.env.GEMINI_MODEL };
        const sourceStartedAt = Date.now();
        const sourceText = await fetchSubtitleText(payload.sourceUrl);
        const sourceFetchMs = Date.now() - sourceStartedAt;
        const sourceBytes = new TextEncoder().encode(sourceText).byteLength;
        const collector = translationPerfCollector();
        const translationStartedAt = Date.now();
        const vtt = await translateSubtitleText(sourceText, {
          apiKey: config.apiKey,
          model: payload.model || config.model || this.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
          concurrency: Number(this.env.TRANSLATION_CONCURRENCY || 3),
          chunkSize: Number(this.env.TRANSLATION_CHUNK_SIZE || 240),
          overlap: Number(this.env.TRANSLATION_CONTEXT_OVERLAP || 5),
          onPerf: collector.onPerf,
        });
        const translationWallMs = Date.now() - translationStartedAt;
        if (new TextEncoder().encode(vtt).byteLength > 1_900_000) throw new Error("Translated subtitle exceeds Durable Object cache size safety limit");
        await this.ctx.storage.put({ vtt, status: "ready", readyAt: Date.now() });
        await this.ctx.storage.delete("payload");
        const perf = collector.summary();
        if (origin === "queue") {
          scheduleDiagnostic(this.env, payload.configId, {
            event: "queue-translation-complete",
            cache: "MISS",
            status: "ready",
            profile: "m21-context",
            attempts: Number(payload.attempts || 1),
            totalMs: Date.now() - pipelineStartedAt,
            queueDelayMs: payload.enqueuedAt ? Math.max(0, pipelineStartedAt - Number(payload.enqueuedAt)) : 0,
            sourceFetchMs,
            sourceBytes,
            parseMs: perf.parseMs,
            cueCount: perf.cueCount,
            expected: perf.cueCount,
            received: perf.cueCount,
            missing: 0,
            chunks: perf.chunks,
            geminiCalls: perf.geminiCalls,
            rateLimits: perf.rateLimits,
            retries: perf.retries,
            semanticRetriesUsed: perf.retries,
            transientRetries: perf.retries,
            retryRecovered: perf.retryRecovered,
            retryWaitMs: 0,
            chunkItems: Number(this.env.TRANSLATION_CHUNK_SIZE || 240),
            concurrency: Number(this.env.TRANSLATION_CONCURRENCY || 3),
            pipelineMs: Date.now() - pipelineStartedAt,
            translationWallMs,
            chunkTimeline: perf.chunkTimeline,
            maxChunkMs: perf.maxChunkMs,
            avgChunkMs: perf.avgChunkMs,
            sumChunkMs: perf.sumChunkMs,
            geminiCallMs: perf.geminiCallMs,
            geminiStatuses: perf.geminiStatuses,
            geminiPromptChars: perf.geminiPromptChars,
          }, this.ctx);
        }
        return vtt;
      } catch (error) {
        await this.ctx.storage.put({ status: "failed", error: String(error?.message || error).slice(0, 500), failedAt: Date.now() });
        if (origin === "queue") {
          scheduleDiagnostic(this.env, payload.configId, {
            event: "queue-translation-failed",
            status: "consumer-failed",
            attempts: Number(payload.attempts || 1),
            profile: "m21-context",
            error: String(error?.message || error),
            failureStage: failureStage(error),
            totalMs: Date.now() - pipelineStartedAt,
            queueDelayMs: payload.enqueuedAt ? Math.max(0, pipelineStartedAt - Number(payload.enqueuedAt)) : 0,
          }, this.ctx);
        }
        throw error;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

export default {
  async fetch(request, env, executionCtx) {
    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
      const url = new URL(request.url);
      const route = routeContext(url.pathname);
      if (url.pathname === "/") return Response.redirect(`${url.origin}/configure`, 302);
      if (url.pathname === "/configure" && request.method === "GET") return new Response(configureHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/configure/token" && request.method === "POST") {
        const body = await request.json();
        const token = await sealConfig(body, env.CONFIG_SECRET);
        return json({ manifestUrl: `${url.origin}/c/${token}/manifest.json` });
      }
      if (url.pathname === "/diagnose" && request.method === "GET") return html(renderRootDiagnosePage(BUILD_ID, BASE_MANIFEST.version));
      if (route.configured && route.path === "/diagnose" && request.method === "GET") {
        await openConfig(route.token, env.CONFIG_SECRET);
        const configId = await configFingerprint(route.token);
        const events = env.DIAGNOSTICS ? await env.DIAGNOSTICS.getByName(configId).read(MAX_EVENTS) : [];
        return html(renderConfiguredDiagnosePage(configId, events, BUILD_ID, BASE_MANIFEST.version));
      }
      if (route.path === "/manifest.json") return json(manifest(route.configured), { headers: { "cache-control": "public, max-age=3600" } });
      const subtitleResponse = await smartSubtitles(request, env, route, executionCtx);
      if (subtitleResponse) return subtitleResponse;
      const vttResponse = await translatedVtt(env, route);
      if (vttResponse) return vttResponse;
      if (route.path === "/health") return json({
        ok: true,
        version: BASE_MANIFEST.version,
        build: BUILD_ID,
        diagnose: true,
        queueConfigured: Boolean(env.TRANSLATION_QUEUE),
        translationJobsConfigured: Boolean(env.TRANSLATION_JOBS),
        diagnosticsConfigured: Boolean(env.DIAGNOSTICS),
      });
      return json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return json({ error: String(error?.message || error) }, { status: 502 });
    }
  },
  async queue(batch, env, executionCtx) {
    await Promise.all(batch.messages.map(async (message) => {
      const payload = { ...(message.body || {}), attempts: Number(message.attempts || 1) };
      try {
        const job = env.TRANSLATION_JOBS.getByName(payload.key);
        await job.run(payload, "queue");
        message.ack();
      } catch (error) {
        scheduleDiagnostic(env, payload.configId, {
          event: "queue-retry-scheduled",
          status: "retrying",
          attempts: Number(message.attempts || 1),
          nextAttempt: Number(message.attempts || 1) + 1,
          retryDelaySeconds: 5,
          failureStage: failureStage(error),
          reason: String(error?.message || error),
        }, executionCtx);
        message.retry({ delaySeconds: 5 });
      }
    }));
  },
};
