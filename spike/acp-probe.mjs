// ACP probe: drives `agy acp`, passes a stdio MCP server per session, rejects every permission request,
// and prints every JSON-RPC message (truncated). Usage: node acp-probe.mjs <cwd> <prompt> [model]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [cwd, prompt, model] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const extra = (process.env.AGY_EXTRA ?? "").split(" ").filter(Boolean);
const agy = spawn("agy", ["acp", ...extra], { cwd, stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
const out = (tag, m) => console.log(tag, JSON.stringify(m).slice(0, 700));
const send = (m) => { out(">>", m); agy.stdin.write(JSON.stringify(m) + "\n"); };
const call = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ jsonrpc: "2.0", id, method, params }); });

createInterface({ input: agy.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return out("RAW", line); }
  out("<<", m);
  if (m.id !== undefined && m.method === undefined) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === "session/request_permission") {
    const opts = m.params?.options ?? [];
    const isPi = /^mcp_pi_/.test(String(m.params?.toolCall?.name ?? ""));
    const reject = isPi ? opts.find((o) => String(o.kind) === "allow_once") : (opts.find((o) => String(o.kind).startsWith("reject")) ?? opts.at(-1));
    send({ jsonrpc: "2.0", id: m.id, result: { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported by probe" } });
  }
});

const init = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
const sess = await call("session/new", { cwd, mcpServers: [{ name: "pi", command: process.execPath, args: [join(here, "fake-mcp.mjs")], env: [{ name: "SPIKE_LOG", value: join(cwd, "mcp.log") }] }] });
const sessionId = sess.result?.sessionId;
if (model && sessionId) await call("session/set_model", { sessionId, modelId: model });
const res = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
out("DONE", res);
agy.kill();
process.exit(0);
