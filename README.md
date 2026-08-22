# SmartSubs Recreated

SmartSubs is a Stremio subtitle addon that prefers existing Malay subtitles and falls back to English subtitles from the official OpenSubtitles v3 Stremio addon. When translation is needed, it uses a user supplied Gemini API key, returns Malay as `msa`, caches translated WebVTT in Cloudflare KV, and can pretranslate through Cloudflare Queues.

This repository was reconstructed from the supplied SmartSubs GitHub Actions recovery workflows. The final recovered source state follows the `final-stable-m20r3` patch line.

## Runtime flow

1. Stremio requests subtitles from a configured SmartSubs URL.
2. SmartSubs forwards the subtitle request to `https://opensubtitles-v3.strem.io`.
3. Existing Malay subtitles are ranked using release and video metadata. Strong matches are returned directly, while weak matches also offer Malay Auto without spending Gemini quota until selected.
4. SmartSubs ranks English candidates using stream metadata such as filename, video hash, video size, resolution, codec, HDR markers, source type, and release group.
5. SmartSubs returns up to five ranked English tracks and exposes a signed Malay Auto subtitle URL when translation is available.
6. Cloudflare Queue can pretranslate the selected English source before the player opens it.
7. Gemini translates timed subtitle cues into Malaysian Malay.
8. Cloudflare KV stores the generated WebVTT for reuse.
9. Queue Join prevents the player path from translating the same subtitle again while background translation is already running.
10. A 9000 ms player wait, 600 ms final grace check, and Delivery Relay make completed translations visible even during a stale KV read.

## Final recovered profile

- Build ID: `final-stable-m20r3`
- User-selected Queue translation: 160 cues, 20000 chars, concurrency 3
- Player Queue wait: 9000 ms plus 600 ms grace
- Background Queue first attempt: 160 cues, 20000 chars, concurrency 3
- Queue fallback attempt: 180 cues, 24000 chars, concurrency 2
- Queue consumer concurrency: 1
- Cache version: `m8-v1`
- Cache TTL: 180 days
- Gemini default model: `gemini-3.5-flash-lite`
- Malay language code returned to Stremio: `msa`
- Translation output: WebVTT
- Built-in English tracks: up to 5
- Delivery Relay TTL: 120 seconds
- Gemini prompt: concise Malaysian Bahasa Melayu

## Required Cloudflare bindings

The final recovered worker expects:

- Secret: `SMARTSUBS_SECRET`
- KV binding: `SMARTSUBS_CACHE`
- Queue producer binding: `SMARTSUBS_TRANSLATION_QUEUE`
- Queue name: `smartsubs-translation`
- Rate limiter binding: `SMARTSUBS_SUBTITLE_LIMITER`
- Rate limiter binding: `SMARTSUBS_GENERATE_LIMITER`
- Durable Object binding: `SMARTSUBS_DELIVERY`

`wrangler.jsonc` keeps the recovered settings. Replace `REPLACE_WITH_KV_NAMESPACE_ID` with the KV namespace ID from your Cloudflare account. The recovered rate limiter namespace IDs are also account specific in practice, so verify them before deployment.

## Local validation

```bash
npm install
npm run check
npm test
npx wrangler deploy --dry-run --outdir .cf-build
```

The SmartSubsV2 parity migration is covered by 120 Node regression tests, including identity-preservation tests for SmartSubs.

## Configuration

SmartSubs uses BYOK. The Gemini key is entered through SmartSubs `/configure`. It is encrypted into the configured addon token using the server secret. It is not stored as a plaintext Worker variable.

After deployment:

1. Open `https://YOUR-WORKER.workers.dev/configure`.
2. Enter your Gemini API key.
3. SmartSubs validates the key and generates a configured Stremio manifest URL.
4. Install that configured manifest in Stremio.
5. Use `/c/YOUR_CONFIG_TOKEN/diagnose` when debugging subtitle selection, queue activity, cache state, and translation failures.

## Recovery note

The supplied workflows contained exact encoded copies of several important source files and exact patch programs for later milestones. Some early supporting modules were referenced by those recovered files but their original bodies were not present in the supplied workflows. Those modules were reconstructed to satisfy the recovered public interfaces and behaviour. See `RECOVERY_ANALYSIS.md` for the exact provenance.
