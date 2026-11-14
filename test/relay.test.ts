import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startRelay } from "../src/relay.ts";

const shim = fileURLToPath(new URL("../src/mcp-shim.mjs", import.meta.url));

function mcpClient(env: Record<string, string>) {
  const child = spawn(process.execPath, [shim], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: any) => void>();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  return {
    child,
    call: (method: string, params: unknown = {}) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); }),
    notify: (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
    close: () => child.kill(),
  };
}

async function setup(engine: any) {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  const relay = await startRelay(engine, join(dir, "r.sock"));
  return { relay, dir, done: async () => { await relay.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("shim: initialize/unknown answered locally; tools/list and tools/call round trip via relay with the session key", async () => {
  const calls: any[] = [];
  const engine = {
    toolsFor: (key: string) => [{ name: "read", description: `d-${key}`, inputSchema: { type: "object" } }],
    handleToolCall: async (key: string, name: string, args: any) => { calls.push({ key, name, args }); return { content: [{ type: "text", text: "hi" }, { type: "image", data: "AAA", mimeType: "image/png" }], isError: false }; },
  };
  const s = await setup(engine);
  const c = mcpClient({ PI_AGY_RELAY: s.relay.path, PI_AGY_KEY: "k1" });
  try {
    const init = await c.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    c.notify("notifications/initialized");
    assert.deepEqual((await c.call("server/discover")).result, {});
    assert.deepEqual((await c.call("tools/list")).result.tools, [{ name: "read", description: "d-k1", inputSchema: { type: "object" } }]);
    const r = await c.call("tools/call", { name: "read", arguments: { path: "a" } });
    assert.deepEqual(r.result, { content: [{ type: "text", text: "hi" }, { type: "image", data: "AAA", mimeType: "image/png" }], isError: false });
    assert.deepEqual(calls, [{ key: "k1", name: "read", args: { path: "a" } }]);
  } finally { c.close(); await s.done(); }
});

test("shim: tools/call stays pending without timeout until the engine resolves; isError is forwarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const engine = { toolsFor: () => [], handleToolCall: async () => { await gate; return { content: [{ type: "text", text: "bad" }], isError: true }; } };
  const s = await setup(engine);
  const c = mcpClient({ PI_AGY_RELAY: s.relay.path, PI_AGY_KEY: "k" });
  try {
    let settled = false;
    const p = c.call("tools/call", { name: "x", arguments: {} }).then((m) => { settled = true; return m; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false);
    release();
    assert.deepEqual((await p).result, { content: [{ type: "text", text: "bad" }], isError: true });
  } finally { c.close(); await s.done(); }
});

test("shim: engine throw and unreachable relay become MCP tool errors, never a crash", async () => {
  const engine = { toolsFor: () => { throw new Error("tl"); }, handleToolCall: async () => { throw new Error("engine exploded"); } };
  const s = await setup(engine);
  const c = mcpClient({ PI_AGY_RELAY: s.relay.path, PI_AGY_KEY: "k" });
  try {
    const r = await c.call("tools/call", { name: "x", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /engine exploded/);
    const l = await c.call("tools/list");
    assert.deepEqual(l.result.tools, []);
  } finally { c.close(); await s.done(); }
  const dead = mcpClient({ PI_AGY_RELAY: "/nonexistent/none.sock", PI_AGY_KEY: "k" });
  try {
    const r = await dead.call("tools/call", { name: "x", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.content[0].type, "text");
    assert.deepEqual((await dead.call("tools/list")).result.tools, []);
    assert.equal(dead.child.exitCode, null);
  } finally { dead.close(); }
});
