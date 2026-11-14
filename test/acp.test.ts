import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const make = () => new AcpClient({ command: process.execPath, args: [fake] });

test("initializes once with protocolVersion 1 and empty clientCapabilities, then answers requests", async () => {
  const c = make();
  try {
    const acp = await c.getAcp();
    assert.deepEqual(await acp.request("init_params", {}), { protocolVersion: 1, clientCapabilities: {} });
    assert.deepEqual(await acp.request("echo", { a: 1 }), { echoed: { a: 1 } });
    const a2 = await c.getAcp();
    assert.equal(a2, acp);
    const p1 = (await acp.request("pid", {})).pid;
    assert.equal((await a2.request("pid", {})).pid, p1);
  } finally { c.kill(); }
});

test("JSON-RPC error responses reject with message, code and data", async () => {
  const c = make();
  try {
    const acp = await c.getAcp();
    await assert.rejects(acp.request("fail", {}), (e: any) => e.message === "boom" && e.code === -32000 && e.data?.x === 1);
    assert.deepEqual(await acp.request("echo", 1), { echoed: 1 }); // still usable
  } finally { c.kill(); }
});

test("notifications flow both ways", async () => {
  const c = make();
  try {
    const acp = await c.getAcp();
    const seen: [string, any][] = [];
    acp.onNotification((m, p) => seen.push([m, p]));
    await acp.request("notify_then", {});
    acp.notify("session/cancel", { sessionId: "s" });
    await acp.request("echo", 0);
    assert.deepEqual(seen[0], ["session/update", { n: 1 }]);
    assert.deepEqual(seen[1], ["echo/note", { got: "session/cancel", params: { sessionId: "s" } }]);
  } finally { c.kill(); }
});

test("agent→client requests are answered through the onRequest handler; handler errors become JSON-RPC errors", async () => {
  const c = make();
  try {
    const acp = await c.getAcp();
    acp.onRequest(async (m, p) => ({ method: m, p }));
    assert.deepEqual(await acp.request("ask", { q: 1 }), { reply: { jsonrpc: "2.0", id: "a1", result: { method: "ask/me", p: { q: 1 } } } });
    acp.onRequest(async () => { throw new Error("nope"); });
    const r = await acp.request("ask", {});
    assert.equal(r.reply.error.message, "nope");
    assert.equal(typeof r.reply.error.code, "number");
  } finally { c.kill(); }
});

test("pending requests reject when the child exits; a later getAcp respawns", async () => {
  const c = make();
  try {
    const acp = await c.getAcp();
    const hang = acp.request("hang", {});
    const die = acp.request("die", {});
    await assert.rejects(hang, /exit/i);
    await assert.rejects(die, /exit/i);
    const again = await c.getAcp();
    assert.deepEqual(await again.request("echo", 2), { echoed: 2 });
  } finally { c.kill(); }
});

test("spawn failure rejects getAcp", async () => {
  const c = new AcpClient({ command: "/nonexistent/agy-binary", args: [] });
  await assert.rejects(c.getAcp());
});
