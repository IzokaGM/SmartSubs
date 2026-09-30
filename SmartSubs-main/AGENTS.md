# SmartSubs: repository instructions for future AI/code patches

Scope: this file applies to **SmartSubs only**. Read the current repository before making changes; do not use code, workflows, or assumptions from other projects. Refer to the latest committed sources and tests rather than an earlier ZIP when a checkout is available.

## Current design and decisions (22 September 2026)

- Subtitle translation uses Gemini with a concise Malaysian TV-style prompt. Preserve meaning, subtitle timing, ID mapping and `responseSchema`; do not rework the prompt while fixing unrelated code.
- The visible *subtitle track ID* for generated Malay is `smartsubs-gemini-<12-character SHA-1 source URL hash>` (implemented in `src/subtitles.js`). The former `smartsubs-auto-` prefix was just a track ID. Do not alter signed `/translated/<token>.vtt` URLs, cache keys, token payloads, cache version, or Gemini translation/prefetch behavior merely to rename this ID. Keep support for previously issued signed links.
- Native Malay tracks are preferred by existing selection logic. **Requested future product direction, not part of the ID rename:** offer a manually selectable Gemini track alongside strong native Malay when an English source and valid user configuration exist. When native Malay is available, do NOT pretranslate solely to present the option; only translate on selection. Confirm changes against current logic and regression tests before shipping.
- VUEO seek causes repeated subtitle requests; this is already established. Do not ask the user to retest seek solely to reconfirm. Repeat requests must not trigger needless Gemini translation or cache writes.
- KV usage samples are cumulative unless specifically marked as a monitor test session. One observed cached episode produced 12 diagnostic KV writes from 5 requests. An observed newly translated episode produced 33 writes (29 diagnostics, 3 queue, 1 translation cache) and 64 reads from 11 requests; later seek/replay increased cumulative totals to 49 writes and 67 reads. These are samples, NOT per-episode constants or capacity promises.
- **Current decision:** KV diagnostic writes remain ON. Do not disable them without explicit approval after reviewing KV Monitor measurements. Keep Gemini, translation cache, queue, delivery, KV Usage Tracker and mobile KV Monitor working; the monitor uses a Durable Object, not extra Workers KV writes. Do not promise a fixed quota saving.
- Do not publish private configured addon URLs, tokens, API keys or client IPs in logs or docs.

## Patch/deployment rules

- The repository uses ONE universal auto-unzip GitHub Actions workflow and ONE SmartSubs CI workflow. **Never create a patch-specific workflow.**
- Deliver future patches as one `.zip` with paths relative to repository root, without an outer project folder. Do not include `.github/` workflow changes unless the user specifically requests them. Include updated regression tests when behavior changes.
- The universal workflow checks/extracts, runs `npm run check` and `npm test`, commits the patch and removes the ZIP if successful. A green GitHub workflow does NOT establish that a new Cloudflare Worker was deployed; check deployment separately.
- Keep changes narrowly scoped. Verify test results before reporting them; distinguish measured KV data from estimates. When user is on a phone, prefer one monitor screenshot to copying Cloudflare log records one-by-one.

## Active baseline / temporary KV audit (24 September 2026)

- The approved base for the current KV Monitor patch is `SmartSubs-main (2).zip` (hard-reset working Gemini Subtitle ID branch) plus **KV Monitor V1 English**; do not reintroduce the later Delivery Fix, auto-session, queue/cache recovery, or source-selection patches.
- KV diagnostic writes remain **ON**. A previous suggestion to disable them by default was **not approved**. Do not change diagnostics or queue/Gemini while changing the monitor.
- KV Monitor manual test history: Start Test snapshots the existing v1 aggregate; End Test saves a numbered difference; tests for the same episode are independent. Keep the original per-episode recording pipeline intact. No VUEO changes; no player session ID is asserted. Do not reset cumulative reports or delete translation cache.
- No installation instructions unless requested. Distinguish local tests from Cloudflare deployment results.
