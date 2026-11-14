// Fake `agy acp` child: newline JSON-RPC over stdio, driven by method name.
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let initParams;
const waiting = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) { const w = waiting.get(m.id); waiting.delete(m.id); return w?.(m); }
  if (m.method === "initialize") { initParams = m.params; return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }); }
  if (m.id === undefined) { return send({ jsonrpc: "2.0", method: "echo/note", params: { got: m.method, params: m.params } }); }
  switch (m.method) {
    case "echo": return send({ jsonrpc: "2.0", id: m.id, result: { echoed: m.params } });
    case "init_params": return send({ jsonrpc: "2.0", id: m.id, result: initParams });
    case "fail": return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "boom", data: { x: 1 } } });
    case "ask": {
      waiting.set("a1", (r) => send({ jsonrpc: "2.0", id: m.id, result: { reply: r } }));
      return send({ jsonrpc: "2.0", id: "a1", method: "ask/me", params: m.params });
    }
    case "notify_then": send({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } }); return send({ jsonrpc: "2.0", id: m.id, result: {} });
    case "hang": return;
    case "die_err": process.stderr.write("x".repeat(5000) + "LOGIN REQUIRED"); return setTimeout(() => process.exit(4), 50);
    case "die": return process.exit(3);
    case "pid": return send({ jsonrpc: "2.0", id: m.id, result: { pid: process.pid } });
  }
});
