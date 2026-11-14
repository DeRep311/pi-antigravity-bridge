import { test } from "node:test";
import assert from "node:assert/strict";
import { generateServerName, isAllowedTool, resolveContext, toolPrefix } from "../src/naming.ts";

test("server names are 'pi' + 8 hex chars and differ between calls", () => {
  const a = generateServerName();
  assert.match(a, /^pi[0-9a-f]{8}$/);
  assert.notEqual(a, generateServerName());
  assert.equal(toolPrefix(a), `mcp_${a}_`);
});

test("isAllowedTool is strict and anchored", () => {
  const p = "mcp_piabcdef12_";
  assert.equal(isAllowedTool(`${p}bash`, p), true);
  assert.equal(isAllowedTool(`${p}a.b-c_d`, p), true);
  for (const bad of [p, `${p}bash\nrm`, `${p}a b`, "bash", "mcp_pi_bash", [`${p}x`], null, undefined, 5]) assert.equal(isAllowedTool(bad, p), false);
  assert.equal(isAllowedTool(`${p}x`, ""), false);
  assert.equal(isAllowedTool(`${p}x`, undefined), false);
});

test("resolveContext prefers the transcript and falls back to context fields", () => {
  const t = [{ name: "t" }];
  const c = [{ name: "c" }];
  assert.deepEqual(resolveContext("SYS", "CTX", t, c), { systemPrompt: "SYS", tools: t });
  assert.deepEqual(resolveContext(undefined, "CTX", undefined, c), { systemPrompt: "CTX", tools: c });
  assert.deepEqual(resolveContext(undefined, undefined, undefined, undefined), { systemPrompt: "", tools: [] });
});
