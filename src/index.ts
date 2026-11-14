// Pi extension entry: registers the "antigravity-bridge" provider backed by `agy acp`.
// Only this file imports @earendil-works/pi-ai (peer dependency).
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { AcpClient } from "./acp.ts";
import { BridgeEngine } from "./engine.ts";
import { createIsolation } from "./isolation.ts";
import { MODELS } from "./models.ts";
import { startRelay } from "./relay.ts";
import type { McpServerSpec, PiMessage } from "./types.ts";

const PROVIDER = "antigravity-bridge";
const SHIM = fileURLToPath(new URL("./mcp-shim.mjs", import.meta.url));
const fallbackKey = `proc-${randomUUID().slice(0, 8)}`;

type Runtime = { engine: BridgeEngine };
let runtime: Promise<Runtime> | undefined;

function getRuntime(): Promise<Runtime> {
  if (runtime) return runtime;
  const p = (async () => {
    const iso = createIsolation();
    let relayPath = "";
    const acp = new AcpClient({ command: process.env.PI_AGY_BIN || "agy", args: ["acp", "--gemini-dir", iso.dir] });
    const engine = new BridgeEngine({
      provider: PROVIDER,
      api: PROVIDER,
      getAcp: () => acp.getAcp(),
      mcpServer: (key: string): McpServerSpec => ({
        name: "pi", command: process.execPath, args: [SHIM],
        env: [{ name: "PI_AGY_RELAY", value: relayPath }, { name: "PI_AGY_KEY", value: key }],
      }),
    });
    const relay = await startRelay(engine);
    relayPath = relay.path;
    // Ordered shutdown: stop agy first so it cannot recreate files, then remove the isolated dir.
    process.removeListener("exit", iso.cleanup);
    process.once("exit", () => { acp.kill("SIGKILL"); iso.cleanup(); });
    return { engine };
  })();
  runtime = p;
  p.catch(() => { if (runtime === p) runtime = undefined; });
  return p;
}

export function streamSimple(model: any, context: any, options?: any) {
  const stream = createAssistantMessageEventStream();
  try { options?.onPayload?.({ model: model.id, systemPrompt: getCurrentSystemPrompt(context.messages) }); } catch { /* ignored */ }
  const input = {
    key: options?.sessionId ?? fallbackKey,
    modelId: model.id,
    reasoning: options?.reasoning,
    systemPrompt: getCurrentSystemPrompt(context.messages) ?? "",
    tools: getCurrentTools(context.messages) ?? [],
    messages: (context.messages as any[]).filter((m) => m.role !== "system") as PiMessage[],
    cwd: process.cwd(),
    signal: options?.signal,
  };
  getRuntime().then(
    (rt) => rt.engine.stream(input, stream),
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({
        type: "error", reason: "error",
        error: {
          role: "assistant", content: [], api: PROVIDER, provider: PROVIDER, model: model.id, stopReason: "error",
          errorMessage: msg, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      });
      stream.end();
    },
  );
  return stream;
}

export default function (pi: any) {
  pi.registerProvider(PROVIDER, {
    name: "Antigravity (agy)",
    baseUrl: PROVIDER,
    apiKey: "not-used",
    api: PROVIDER,
    models: MODELS,
    streamSimple,
  });
}
