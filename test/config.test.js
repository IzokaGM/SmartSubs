import test from "node:test";
import assert from "node:assert/strict";
import { openConfig, sealConfig } from "../src/config.js";

test("BYOK configuration round trips without expiry fields", async () => {
  const token = await sealConfig({ apiKey: "test-key", model: "gemini-3.5-flash-lite" }, "secret");
  const cfg = await openConfig(token, "secret");
  assert.equal(cfg.apiKey, "test-key");
  assert.equal(cfg.model, "gemini-3.5-flash-lite");
  assert.equal(cfg.expiresAt, undefined);
});

test("wrong config secret cannot decrypt token", async () => {
  const token = await sealConfig({ apiKey: "test-key" }, "secret-a");
  await assert.rejects(() => openConfig(token, "secret-b"), /Invalid SmartSubs/);
});
