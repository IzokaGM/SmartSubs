import { DurableObject } from "cloudflare:workers";
import { configureHtml, openConfig, sealConfig } from "./config.js";
import { chooseSubtitlePlan } from "./selector.js";
import { fetchSubtitleText, translateSubtitleText } from "./translator.js";
import { json, parseExtra, sha256Hex, withCors } from "./utils.js";

const BASE_MANIFEST = {
  id: "org.smartsubs.malay",
  version: "2.1.0",
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

async function smartSubtitles(request, env, route) {
  const url = new URL(request.url);
  const match = route.path.match(/^\/subtitles\/(movie|series)\/([^/]+)(?:\/(.*))?\.json$/);
  if (!match) return null;
  if (!route.token && !env.GEMINI_API_KEY) throw new Error("Configure SmartSubs first at /configure");

  const [, type, encodedId, rawExtra = ""] = match;
  const id = decodeURIComponent(encodedId);
  const extraString = rawExtra || "";
  const extra = parseExtra(extraString);
  const config = route.token ? await openConfig(route.token, env.CONFIG_SECRET) : { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-3.5-flash-lite" };
  const subtitles = await fetchOpenSubtitles(type, id, extraString, env);
  const plan = chooseSubtitlePlan(subtitles, extra);
  const result = [];

  if (plan.mode === "native" && plan.bestMalay?.item?.url) {
    result.push({ id: `smartsubs-native-${plan.bestMalay.item.id || "ms"}`, url: plan.bestMalay.item.url, lang: "Malay" });
  } else if (plan.mode === "translate" && plan.bestEnglish?.item?.url) {
    const source = plan.bestEnglish.item;
    const model = config.model || env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const key = await translationKey(source, model);
    const job = env.TRANSLATION_JOBS.getByName(key);
    await job.ensure({ key, sourceUrl: source.url, model, token: route.token || null });
    const prefix = route.token ? `/c/${route.token}` : "";
    result.push({ id: `smartsubs-auto-${key.slice(0, 12)}`, url: `${url.origin}${prefix}/vtt/${key}.vtt`, lang: "Malay Auto" });
  }

  return json({ subtitles: result }, { headers: { "cache-control": "public, max-age=30" } });
}

async function translatedVtt(env, route) {
  const match = route.path.match(/^\/vtt\/([a-f0-9]{64})\.vtt$/);
  if (!match) return null;
  const key = match[1];
  const job = env.TRANSLATION_JOBS.getByName(key);
  const vtt = await job.getOrRun(route.token || null);
  return new Response(vtt, {
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}

export class TranslationJob extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.inflight = null;
  }

  async ensure(payload) {
    const cached = await this.ctx.storage.get("vtt");
    if (cached) return { status: "ready" };
    await this.ctx.storage.put("payload", payload);
    const status = await this.ctx.storage.get("status");
    if (status !== "queued" && status !== "running") {
      await this.ctx.storage.put("status", "queued");
      await this.env.TRANSLATION_QUEUE.send(payload);
    }
    return { status: "queued" };
  }

  async getOrRun(requestToken = null) {
    const cached = await this.ctx.storage.get("vtt");
    if (cached) return cached;
    const payload = await this.ctx.storage.get("payload");
    if (!payload) throw new Error("Translation job payload is missing");
    if (requestToken && !payload.token) payload.token = requestToken;
    return this.run(payload);
  }

  async run(payload) {
    const cached = await this.ctx.storage.get("vtt");
    if (cached) return cached;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      await this.ctx.storage.put("status", "running");
      try {
        const config = payload.token
          ? await openConfig(payload.token, this.env.CONFIG_SECRET)
          : { apiKey: this.env.GEMINI_API_KEY, model: payload.model || this.env.GEMINI_MODEL };
        const sourceText = await fetchSubtitleText(payload.sourceUrl);
        const vtt = await translateSubtitleText(sourceText, {
          apiKey: config.apiKey,
          model: payload.model || config.model || this.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
          concurrency: Number(this.env.TRANSLATION_CONCURRENCY || 3),
          chunkSize: Number(this.env.TRANSLATION_CHUNK_SIZE || 240),
          overlap: Number(this.env.TRANSLATION_CONTEXT_OVERLAP || 5),
        });
        if (new TextEncoder().encode(vtt).byteLength > 1_900_000) throw new Error("Translated subtitle exceeds Durable Object cache size safety limit");
        await this.ctx.storage.put({ vtt, status: "ready", readyAt: Date.now() });
        await this.ctx.storage.delete("payload");
        return vtt;
      } catch (error) {
        await this.ctx.storage.put({ status: "failed", error: String(error?.message || error).slice(0, 500), failedAt: Date.now() });
        throw error;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }
}

export default {
  async fetch(request, env) {
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
      if (route.path === "/manifest.json") return json(manifest(route.configured), { headers: { "cache-control": "public, max-age=3600" } });

      const subtitleResponse = await smartSubtitles(request, env, route);
      if (subtitleResponse) return subtitleResponse;
      const vttResponse = await translatedVtt(env, route);
      if (vttResponse) return vttResponse;
      if (route.path === "/health") return json({ ok: true, version: BASE_MANIFEST.version });
      return json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return json({ error: String(error?.message || error) }, { status: 502 });
    }
  },

  async queue(batch, env) {
    await Promise.all(batch.messages.map(async (message) => {
      try {
        const payload = message.body;
        const job = env.TRANSLATION_JOBS.getByName(payload.key);
        await job.run(payload);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 5 });
      }
    }));
  },
};
