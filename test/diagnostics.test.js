import test from "node:test";
import assert from "node:assert/strict";
import { deriveVerdict, pruneEvents, renderConfiguredDiagnosePage, sanitiseEvent } from "../src/diagnostics.js";

test("diagnostics omit tokens and source URLs", () => {
  const row = sanitiseEvent({ event: "queue-enqueued", token: "secret-token", sourceUrl: "https://secret.example/sub.srt", status: "queued" });
  assert.equal(row.status, "queued");
  assert.equal(row.token, undefined);
  assert.equal(row.sourceUrl, undefined);
});

test("verdict follows queue prefetch lifecycle", () => {
  const base = Date.now();
  const subtitle = { ts: base, event: "subtitle-result", result: "malay-auto", subtitleCount: 1, englishFound: true, autoReady: true };
  assert.equal(deriveVerdict([subtitle, { ts: base + 1, event: "queue-enqueued", status: "queued" }]), "QUEUE_PREFETCH_QUEUED");
  assert.equal(deriveVerdict([subtitle, { ts: base + 2, event: "queue-translation-start", status: "consumer" }]), "QUEUE_PREFETCH_TRANSLATING");
  assert.equal(deriveVerdict([subtitle, { ts: base + 3, event: "queue-translation-complete", status: "ready" }]), "QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION");
  assert.equal(deriveVerdict([subtitle, { ts: base + 4, event: "translation-delivered", status: "ready" }]), "TRANSLATION_DELIVERED");
});

test("diagnostics keep at most 50 recent events", () => {
  const now = Date.now();
  const events = Array.from({ length: 80 }, (_, i) => ({ ts: now - i, event: "x", totalMs: i }));
  assert.equal(pruneEvents(events).length, 50);
});

test("diagnose HTML contains performance and verdict without raw token", () => {
  const html = renderConfiguredDiagnosePage("abc123fingerprint", [{ ts: Date.now(), event: "subtitle-result", result: "native-malay", subtitleCount: 1 }], "m21.1-diagnose", "2.1.1");
  assert.match(html, /NATIVE_MALAY_RETURNED/);
  assert.match(html, /Latest performance/);
  assert.doesNotMatch(html, /YOUR_REAL_CONFIG_TOKEN/);
});
