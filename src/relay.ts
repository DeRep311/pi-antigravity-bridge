// Unix-socket relay between the stdio MCP shim (spawned by agy) and the in-process engine.
// Protocol: one connection per request; one JSON line in, one JSON line out. No timeouts: tool calls
// stay pending while Pi runs the tool.
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { McpToolResult } from "./types.ts";

export interface RelayEngine {
  toolsFor(session: string): unknown[];
  handleToolCall(session: string, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export type Relay = { path: string; close(): Promise<void> };

export async function startRelay(engine: RelayEngine, socketPath?: string): Promise<Relay> {
  let ownDir: string | undefined;
  if (!socketPath) {
    ownDir = mkdtempSync(join(tmpdir(), "pi-agy-relay-"));
    socketPath = join(ownDir, "relay.sock");
  }
  const path = socketPath;
  const server: Server = createServer((sock) => {
    sock.on("error", () => {});
    createInterface({ input: sock }).once("line", async (line) => {
      let out: object;
      try {
        const req = JSON.parse(line);
        if (req.op === "tools/list") out = { result: engine.toolsFor(String(req.session)) };
        else if (req.op === "tools/call") out = { result: await engine.handleToolCall(String(req.session), String(req.name), req.args ?? {}) };
        else out = { error: `unknown relay op: ${req.op}` };
      } catch (e) {
        out = { error: e instanceof Error ? e.message : String(e) };
      }
      if (!sock.destroyed) sock.end(JSON.stringify(out) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
  // Idle relay must not keep the host alive; open shim connections (in-flight tool calls) still do.
  server.unref();
  const removeOwnDir = () => { if (ownDir) rmSync(ownDir, { recursive: true, force: true }); };
  process.once("exit", removeOwnDir);
  return {
    path,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { process.removeListener("exit", removeOwnDir); removeOwnDir(); resolve(); });
      server.closeAllConnections?.();
    }),
  };
}
