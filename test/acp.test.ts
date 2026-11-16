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

test("an idle client and relay do not keep the host process alive (Pi -p must exit)", async () => {
  const { spawn } = await import("node:child_process");
  const script = fileURLToPath(new URL("./fixtures/idle-exit.ts", import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, 5000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  const [tag, sock] = out.trim().split(" ");
  assert.equal(tag, "IDLE");
  assert.equal(code, 0, "process should exit by itself once idle");
  const { existsSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  assert.equal(existsSync(dirname(sock)), false, "relay socket dir is removed on exit");
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

test("child exit error carries the tail of agy stderr (bounded)", async () => {
  const c = make();
  try {
    const acp = await c.getAcp();
    const err = await acp.request("die_err", {}).catch((e) => e as Error);
    assert.match(err.message, /exited \(code 4/);
    assert.match(err.message, /LOGIN REQUIRED/);
    assert.ok(err.message.length < 2300);
  } finally { c.kill(); }
});

test("spawn failure message names the missing binary", async () => {
  const c = new AcpClient({ command: "agy-missing-binary-xyz", args: [] });
  await assert.rejects(c.getAcp(), /ENOENT/);
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function initCase(mode: "fail" | "hang", extra: object = {}) {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const pidfile = join(mkdtempSync(join(tmpdir(), "acp-init-")), "pid");
  const c = new AcpClient({ command: process.execPath, args: [fake], env: { ...process.env, FAKE_ACP_INIT: mode, FAKE_ACP_PIDFILE: pidfile }, ...extra });
  const err = await c.getAcp().then(() => null, (e) => e as Error);
  await new Promise((r) => setTimeout(r, 100));
  return { c, err, pid: Number(readFileSync(pidfile, "utf8")) };
}

test("initialize failure kills the agy child instead of orphaning it", async () => {
  const { c, err, pid } = await initCase("fail");
  try {
    assert.match(String(err?.message), /not logged in/);
    assert.equal(alive(pid), false, "the failed child must be killed");
  } finally { c.kill(); }
});

test("an initialize that never answers times out and kills the child", async () => {
  const { c, err, pid } = await initCase("hang", { initTimeoutMs: 150 });
  try {
    assert.match(String(err?.message), /initialize timed out/);
    assert.equal(alive(pid), false, "the silent child must be killed");
  } finally { c.kill(); }
});
