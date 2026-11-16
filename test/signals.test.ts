import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fixtures/signal-host.ts", import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

async function start(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  assert.ok(await until(() => out.includes("READY ")), "host did not start");
  const info = JSON.parse(out.split("READY ")[1].split("\n")[0]) as { iso: string; sock: string; pid: number };
  return { child, exited, info, out: () => out };
}

async function assertCleaned(info: { iso: string; sock: string; pid: number }) {
  assert.ok(await until(() => !existsSync(info.iso) && !existsSync(dirname(info.sock)) && !alive(info.pid)),
    `leaked: iso=${existsSync(info.iso)} relay=${existsSync(dirname(info.sock))} agy=${alive(info.pid)}`);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`${sig} cleans up and the host still dies by that signal`, async () => {
    const h = await start();
    assert.ok(existsSync(h.info.iso) && existsSync(dirname(h.info.sock)) && alive(h.info.pid));
    h.child.kill(sig);
    const r = await Promise.race([h.exited, new Promise<null>((res) => setTimeout(() => res(null), 5000))]);
    if (!r) h.child.kill("SIGKILL");
    assert.ok(r, "host did not terminate");
    assert.equal(r.signal, sig);
    await assertCleaned(h.info);
  });
}

test("with a host SIGINT listener (Pi's interrupt) the bridge leaves everything in place; a later host exit cleans up", async () => {
  const h = await start({ SIGNAL_HOST_OWN: "SIGINT" });
  try {
    h.child.kill("SIGINT");
    assert.ok(await until(() => h.out().includes("HOST-HANDLER")));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.child.exitCode, null);
    assert.equal(h.child.signalCode, null);
    assert.ok(existsSync(h.info.iso), "the isolated gemini dir (deny hook) must survive an interrupt");
    assert.ok(existsSync(dirname(h.info.sock)), "the relay socket dir must survive an interrupt");
    assert.ok(alive(h.info.pid), "agy must keep running after an interrupt");
    h.child.kill("SIGINT"); // the host handler exits on the second signal
    const r = await Promise.race([h.exited, new Promise<null>((res) => setTimeout(() => res(null), 5000))]);
    assert.ok(r, "host did not exit");
    assert.equal(r.code, 0);
    await assertCleaned(h.info);
  } finally {
    if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGKILL");
    await h.exited;
  }
});
