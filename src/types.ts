// Structural types shared by the bridge. They mirror the pi-ai shapes the bridge reads and emits,
// so the core stays testable without importing pi-ai at runtime.

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type PiMessage =
  | { role: "user"; content: string | (TextBlock | ImageBlock)[]; timestamp: number }
  | { role: "assistant"; content: (TextBlock | ThinkingBlock | ToolCallBlock)[]; timestamp: number; [k: string]: unknown }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: (TextBlock | ImageBlock)[]; isError: boolean; timestamp: number; [k: string]: unknown };

export type PiTool = { name: string; description: string; parameters: object };

export type Usage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type AssistantMessage = {
  role: "assistant";
  content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
  errorMessage?: string;
};

/** Minimal surface of pi-ai's AssistantMessageEventStream used by the bridge. */
export interface EventSink {
  push(event: object): void;
  end(): void;
}

export type StreamInput = {
  /** Pi session id (or a per-process fallback); one agy ACP session per key. */
  key: string;
  modelId: string;
  reasoning?: string;
  systemPrompt: string;
  tools: PiTool[];
  /** Transcript without system messages. */
  messages: PiMessage[];
  cwd: string;
  signal?: AbortSignal;
};

/** JSON-RPC peer for `agy acp`. */
export interface AcpLike {
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params: unknown): void;
  onNotification(handler: (method: string, params: any) => void): void;
  onRequest(handler: (method: string, params: any) => Promise<any>): void;
}

export type McpServerSpec = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };

export type McpToolResult = { content: (TextBlock | ImageBlock)[]; isError: boolean };
