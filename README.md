# SmartSubs M21 

Fast Malay subtitles for Stremio using OpenSubtitles v3, Gemini 3.5 Flash-Lite, Cloudflare Queues, and SQLite-backed Durable Objects.

## M21 goals

- Prefer a strongly matched native Malay subtitle when confidence is good.
- Otherwise translate the best-matched English subtitle.
- Start translation as soon as Stremio requests subtitle choices.
- Translate up to three large chunks in parallel with five-cue context overlap, reducing Gemini round trips.
- Use one Durable Object per exact source subtitle for single-flight translation and persistent VTT caching.
- Keep the existing BYOK approach without adding expiry or revocation.
- Keep runtime work on Cloudflare. GitHub Actions is used only for source generation, checks, tests, and commits.

## Cloudflare setup

1. `npm install`
2. Create the queue once: `npx wrangler queues create smartsubs-translation`
3. Set a long random configuration secret: `npx wrangler secret put CONFIG_SECRET`
4. Deploy: `npx wrangler deploy`
5. Open `https://YOUR-WORKER.workers.dev/configure`, enter your Gemini key, and install the generated manifest URL in Stremio.

Optional fallback for direct unconfigured use: `npx wrangler secret put GEMINI_API_KEY`.

The default model is `gemini-3.5-flash-lite`. The Gemini key is encrypted into the configured add-on token. M21 intentionally does not add token expiry or revocation.
