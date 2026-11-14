// MCP server naming and tool-name guards shared by the bridge, the engine and the deny hook config.
import { randomBytes } from "node:crypto";

/** Unguessable per-process server name (letters/digits only) so a workspace MCP server cannot collide. */
export function generateServerName(): string {
  return `pi${randomBytes(4).toString("hex")}`;
}

/** agy exposes MCP tools as `mcp_<serverName>_<toolName>`. */
export function toolPrefix(serverName: string): string {
  return `mcp_${serverName}_`;
}

/** Strict, anchored check: a string made of the prefix plus a plain tool name. */
export function isAllowedTool(name: unknown, prefix: unknown): boolean {
  if (typeof name !== "string" || typeof prefix !== "string" || prefix === "") return false;
  if (!name.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_.-]+$/.test(name.slice(prefix.length));
}

/** Prefer what the transcript carries; fall back to the context fields Pi passes alongside it. */
export function resolveContext<T>(fromTranscript: string | undefined, fromContext: unknown, toolsT: T[] | undefined, toolsC: unknown) {
  const systemPrompt = fromTranscript ?? (typeof fromContext === "string" ? fromContext : "");
  const tools = toolsT ?? (Array.isArray(toolsC) ? (toolsC as T[]) : []);
  return { systemPrompt, tools };
}
