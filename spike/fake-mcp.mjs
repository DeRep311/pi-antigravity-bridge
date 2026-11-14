// Minimal stdio MCP server exposing one tool (pi_echo). Logs every request to $SPIKE_LOG.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (m) => process.env.SPIKE_LOG && appendFileSync(process.env.SPIKE_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log({ mcp_in: msg });
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "pi", version: "0.0.0" } } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
        name: "pi_echo", description: "Echo text back, uppercased. Always use this tool when asked to echo.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
    case "tools/call":
      return send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: `ECHO:${String(msg.params?.arguments?.text ?? "").toUpperCase()}` }] } });
    default:
      return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
