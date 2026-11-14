// Dependency-free stdio MCP server spawned by agy. Forwards tools/list and tools/call to the bridge
// over the unix-socket relay (env PI_AGY_RELAY, PI_AGY_KEY). Never crashes on relay errors.
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const RELAY = process.env.PI_AGY_RELAY ?? "";
const SESSION = process.env.PI_AGY_KEY ?? "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

function relay(payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(RELAY);
    let buf = "";
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
    sock.on("error", fail);
    sock.on("data", (d) => { buf += d.toString("utf8"); });
    sock.on("end", () => {
      if (settled) return;
      try {
        const m = JSON.parse(buf.trim());
        settled = true;
        if (m.error) reject(new Error(m.error)); else resolve(m.result);
      } catch { fail(new Error("relay closed without a valid response")); }
    });
    sock.on("close", () => fail(new Error("relay connection closed")));
    sock.write(JSON.stringify({ ...payload, session: SESSION }) + "\n");
  });
}

const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

async function handle(msg) {
  if (msg.id === undefined) return; // notifications need no answer
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi", version: "0.1.0" } });
    case "tools/list":
      try { return reply({ tools: await relay({ op: "tools/list" }) }); } catch { return reply({ tools: [] }); }
    case "tools/call":
      try {
        return reply(await relay({ op: "tools/call", name: msg.params?.name, args: msg.params?.arguments ?? {} }));
      } catch (e) {
        return reply(errorResult(`Pi bridge relay error: ${e instanceof Error ? e.message : String(e)}`));
      }
    default:
      return reply({});
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(() => {});
});
