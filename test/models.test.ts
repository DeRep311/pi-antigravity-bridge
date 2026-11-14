import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, resolveVariant } from "../src/models.ts";

test("catalog exposes base Gemini families as reasoning models", () => {
  const ids = MODELS.map((m) => m.id);
  assert.deepEqual(ids, ["gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"]);
  for (const m of MODELS) {
    assert.equal(m.reasoning, true);
    assert.deepEqual(m.input, ["text", "image"]);
    assert.equal(m.contextWindow, 1048576);
    assert.ok(m.maxTokens > 0);
    assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
});

const available = [
  "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high",
  "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh",
  "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
];

test("maps Pi reasoning levels to agy model variants", () => {
  assert.equal(resolveVariant("gemini-4-argon", "minimal", available), "gemini-4-argon-low");
  assert.equal(resolveVariant("gemini-4-argon", "low", available), "gemini-4-argon-low");
  assert.equal(resolveVariant("gemini-4-argon", "medium", available), "gemini-4-argon-medium");
  assert.equal(resolveVariant("gemini-4-argon", "high", available), "gemini-4-argon-high");
  assert.equal(resolveVariant("gemini-4-hydrogen", "xhigh", available), "gemini-4-hydrogen-xhigh");
  assert.equal(resolveVariant("gemini-4-hydrogen", "max", available), "gemini-4-hydrogen-xhigh");
});

test("falls back to the nearest lower available level, then medium default", () => {
  assert.equal(resolveVariant("gemini-4-argon", "xhigh", available), "gemini-4-argon-high");
  assert.equal(resolveVariant("gemini-3.8-flash", undefined, available), "gemini-3.8-flash-medium");
  assert.equal(resolveVariant("gemini-3.8-flash", "off", available), "gemini-3.8-flash-low");
});

test("passes through explicit variant ids and unknown models unchanged", () => {
  assert.equal(resolveVariant("gemini-4-argon-high", "low", available), "gemini-4-argon-high");
  assert.equal(resolveVariant("some-future-model", "high", available), "some-future-model");
});
