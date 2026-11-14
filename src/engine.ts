// Turn engine: maps Pi streamSimple calls onto persistent agy ACP sessions.
//
// One agy session per Pi session key. A Pi tool call surfaces as an MCP tools/call from the shim;
// the engine emits it as a Pi toolCall, ends the Pi stream with "toolUse" and parks the MCP request.
// Pi runs the tool and calls streamSimple again with the result, which resolves the parked request
// and lets the same agy prompt continue into the new Pi stream.
import { randomUUID } from "node:crypto";
import { resolveVariant } from "./models.ts";
import { digestMessages, renderNewUserMessages, renderReplayPrompt } from "./transcript.ts";
import type {
  AcpLike, AssistantMessage, EventSink, McpServerSpec, McpToolResult, PiMessage, PiTool, StopReason,
  StreamInput, Usage,
} from "./types.ts";

export type EngineDeps = {
  getAcp(): Promise<AcpLike>;
  mcpServer(key: string): McpServerSpec;
  provider: string;
  api: string;
  now?: () => number;
  /** Window to gather parallel MCP calls into one toolUse turn. */
  flushDelayMs?: number;
};

type Op = (b: MessageBuilder) => void;
type QueuedCall = { id: string; name: string; args: Record<string, unknown>; resolve: (r: McpToolResult) => void };
type Final = { kind: "done"; reason: StopReason; usage?: Usage } | { kind: "error"; reason: "error" | "aborted"; message: string };

type SessionState = {
  key: string;
  acp: AcpLike;
  sessionId: string;
  available: string[];
  variant: string;
  modelId: string;
  tools: PiTool[];
  toolsDigest: string;
  systemDigest: string;
  /** Number of transcript messages already represented in the agy session (before our reply). */
  consumedLen: number;
  consumedDigest: string;
  promptActive: boolean;
  dead: boolean;
  builder: MessageBuilder | null;
  pendingOps: Op[];
  pendingFinal: Final | null;
  queued: QueuedCall[];
  parked: Map<string, (r: McpToolResult) => void>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } });

export function mapUsage(u: any): Usage {
  if (!u) return emptyUsage();
  const usage: Usage = {
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cachedReadTokens ?? 0,
    cacheWrite: u.cachedWriteTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
    cost: { ...ZERO_COST },
  };
  if (typeof u.thoughtTokens === "number") usage.reasoning = u.thoughtTokens;
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}), totalTokens: usage.totalTokens, cost: usage.cost };
}

export function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "cancelled":
      return "aborted";
    case "refusal":
      return "error";
    default:
      return "stop";
  }
}

/** Builds one Pi AssistantMessage and pushes the matching event sequence to a sink. */
export class MessageBuilder {
  readonly message: AssistantMessage;
  private started = false;
  private open: { kind: "text" | "thinking"; index: number } | null = null;
  private closed = false;
  private sink: EventSink;

  constructor(sink: EventSink, base: Omit<AssistantMessage, "content" | "usage" | "stopReason">) {
    this.sink = sink;
    this.message = { ...base, content: [], usage: emptyUsage(), stopReason: "stop" };
  }

  private start() {
    if (this.started) return;
    this.started = true;
    this.sink.push({ type: "start", partial: this.message });
  }

  private closeBlock() {
    if (!this.open) return;
    const { kind, index } = this.open;
    this.open = null;
    this.sink.push({ type: `${kind}_end`, contentIndex: index, content: (this.message.content[index] as any)[kind], partial: this.message });
  }

  delta(kind: "text" | "thinking", delta: string) {
    if (this.closed || !delta) return;
    this.start();
    if (this.open?.kind !== kind) {
      this.closeBlock();
      const index = this.message.content.length;
      this.message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      this.open = { kind, index };
      this.sink.push({ type: `${kind}_start`, contentIndex: index, partial: this.message });
    }
    const block = this.message.content[this.open.index] as any;
    block[kind] += delta;
    this.sink.push({ type: `${kind}_delta`, contentIndex: this.open.index, delta, partial: this.message });
  }

  toolCall(id: string, name: string, args: Record<string, unknown>) {
    if (this.closed) return;
    this.start();
    this.closeBlock();
    const index = this.message.content.length;
    const toolCall = { type: "toolCall" as const, id, name, arguments: args };
    this.message.content.push(toolCall);
    this.sink.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
    this.sink.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.message });
  }

  finish(reason: StopReason, usage?: Usage) {
    if (this.closed) return;
    this.start();
    this.closeBlock();
    this.closed = true;
    this.message.stopReason = reason;
    if (usage) this.message.usage = usage;
    if (reason === "error" || reason === "aborted") {
      this.sink.push({ type: "error", reason, error: this.message });
    } else {
      this.sink.push({ type: "done", reason, message: this.message });
    }
    this.sink.end();
  }

  fail(reason: "error" | "aborted", errorMessage: string) {
    if (this.closed) return;
    this.closeBlock();
    this.closed = true;
    this.message.stopReason = reason;
    this.message.errorMessage = errorMessage;
    this.sink.push({ type: "error", reason, error: this.message });
    this.sink.end();
  }
}

function pickOption(options: { optionId: string; kind: string }[], prefix: "allow" | "reject") {
  return options.find((o) => o.kind === `${prefix}_once`) ?? options.find((o) => o.kind.startsWith(prefix));
}

export class BridgeEngine {
  private states = new Map<string, SessionState>();
  private bySessionId = new Map<string, SessionState>();
  private wired = new WeakSet<AcpLike>();
  /** Tools of sessions being created: agy lists MCP tools while session/new is still in flight. */
  private creatingTools = new Map<string, PiTool[]>();
  private now: () => number;
  private deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Pi tools for the shim's tools/list, as MCP tool descriptors. */
  toolsFor(key: string) {
    const tools = this.creatingTools.get(key) ?? this.states.get(key)?.tools ?? [];
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
  }

  /** Entry point for the shim's tools/call: resolves when Pi delivers the tool result. */
  handleToolCall(key: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const st = this.states.get(key);
    if (!st || st.dead) return Promise.resolve({ content: [{ type: "text", text: "No active Pi turn for this tool call." }], isError: true });
    return new Promise((resolve) => {
      st.queued.push({ id: `agy_${randomUUID().slice(0, 12)}`, name, args: args ?? {}, resolve });
      this.scheduleFlush(st);
    });
  }

  stream(input: StreamInput, sink: EventSink): void {
    this.run(input, sink).catch((err) => {
      const builder = new MessageBuilder(sink, this.base(input.modelId));
      builder.fail("error", errorText(err));
      const st = this.states.get(input.key);
      if (st) this.discard(st);
    });
  }

  private base(modelId: string) {
    return { role: "assistant" as const, api: this.deps.api, provider: this.deps.provider, model: modelId, timestamp: this.now() };
  }

  private async run(input: StreamInput, sink: EventSink) {
    if (input.signal?.aborted) {
      new MessageBuilder(sink, this.base(input.modelId)).fail("aborted", "Aborted before start");
      return;
    }
    const messages = input.messages;
    const toolsDigest = digestMessages([{ role: "user", content: JSON.stringify(input.tools), timestamp: 0 }]);
    const systemDigest = digestMessages([{ role: "user", content: input.systemPrompt, timestamp: 0 }]);
    let st = this.states.get(input.key);

    const continuesHistory = (s: SessionState) =>
      messages.length > s.consumedLen &&
      digestMessages(messages.slice(0, s.consumedLen)) === s.consumedDigest &&
      messages[s.consumedLen].role === "assistant" &&
      s.toolsDigest === toolsDigest &&
      s.systemDigest === systemDigest;

    // 1) Resume a parked tool loop.
    if (st && st.promptActive && st.parked.size > 0 && continuesHistory(st)) {
      const results = messages.slice(st.consumedLen + 1);
      const byId = new Map(results.filter((m) => m.role === "toolResult").map((m) => [(m as any).toolCallId, m]));
      if ([...st.parked.keys()].every((id) => byId.has(id))) {
        this.attach(st, input, sink, messages);
        for (const [id, resolve] of st.parked) {
          const r = byId.get(id) as Extract<PiMessage, { role: "toolResult" }>;
          resolve({ content: r.content, isError: r.isError });
        }
        st.parked.clear();
        this.scheduleFlush(st);
        return;
      }
    }

    // 2) Follow-up user turn on an idle session.
    if (st && !st.promptActive && st.parked.size === 0 && continuesHistory(st)) {
      const fresh = messages.slice(st.consumedLen + 1);
      if (fresh.length > 0 && fresh.every((m) => m.role === "user")) {
        await this.selectModel(st, input);
        this.attach(st, input, sink, messages);
        this.prompt(st, renderNewUserMessages(fresh));
        return;
      }
    }

    // 3) New or diverged conversation: fresh agy session with the transcript replayed.
    if (st) this.discard(st, true);
    st = await this.createSession(input, toolsDigest, systemDigest);
    this.attach(st, input, sink, messages);
    this.prompt(st, renderReplayPrompt(input.systemPrompt, messages));
  }

  private async createSession(input: StreamInput, toolsDigest: string, systemDigest: string): Promise<SessionState> {
    const acp = await this.deps.getAcp();
    this.wire(acp);
    this.creatingTools.set(input.key, input.tools);
    let res: any;
    try {
      res = await acp.request("session/new", { cwd: input.cwd, mcpServers: [this.deps.mcpServer(input.key)] });
    } finally {
      this.creatingTools.delete(input.key);
    }
    const available: string[] = (res?.models?.availableModels ?? []).map((m: any) => m.modelId);
    const st: SessionState = {
      key: input.key, acp, sessionId: res.sessionId, available, variant: "", modelId: input.modelId,
      tools: input.tools, toolsDigest, systemDigest, consumedLen: 0, consumedDigest: "",
      promptActive: false, dead: false, builder: null, pendingOps: [], pendingFinal: null,
      queued: [], parked: new Map(), flushTimer: null, detachAbort: null,
    };
    this.states.set(input.key, st);
    this.bySessionId.set(st.sessionId, st);
    await this.selectModel(st, input);
    return st;
  }

  private async selectModel(st: SessionState, input: StreamInput) {
    const variant = resolveVariant(input.modelId, input.reasoning, st.available);
    st.modelId = input.modelId;
    if (variant === st.variant) return;
    await st.acp.request("session/set_model", { sessionId: st.sessionId, modelId: variant });
    st.variant = variant;
  }

  /** Bind the current Pi stream to the session and flush anything agy produced in between. */
  private attach(st: SessionState, input: StreamInput, sink: EventSink, messages: PiMessage[]) {
    st.consumedLen = messages.length;
    st.consumedDigest = digestMessages(messages);
    st.builder = new MessageBuilder(sink, this.base(input.modelId));
    st.detachAbort?.();
    st.detachAbort = null;
    if (input.signal) {
      const onAbort = () => this.abort(st);
      input.signal.addEventListener("abort", onAbort, { once: true });
      st.detachAbort = () => input.signal!.removeEventListener("abort", onAbort);
    }
    for (const op of st.pendingOps.splice(0)) op(st.builder);
    if (st.pendingFinal) {
      const f = st.pendingFinal;
      st.pendingFinal = null;
      this.complete(st, f);
    }
  }

  private prompt(st: SessionState, prompt: unknown[]) {
    st.promptActive = true;
    st.acp.request("session/prompt", { sessionId: st.sessionId, prompt }).then(
      (res) => {
        if (st.dead) return;
        st.promptActive = false;
        this.failParked(st, "The agy turn ended before this tool result was delivered.");
        this.complete(st, { kind: "done", reason: mapStopReason(res?.stopReason), usage: mapUsage(res?.usage) });
      },
      (err) => {
        if (st.dead) return;
        st.promptActive = false;
        this.complete(st, { kind: "error", reason: "error", message: errorText(err) });
        this.discard(st);
      },
    );
  }

  private complete(st: SessionState, final: Final) {
    const b = st.builder;
    if (!b) {
      st.pendingFinal = final;
      return;
    }
    st.builder = null;
    st.detachAbort?.();
    st.detachAbort = null;
    if (final.kind === "done") b.finish(final.reason, final.usage);
    else b.fail(final.reason, final.message);
  }

  private apply(st: SessionState, op: Op) {
    if (st.builder) op(st.builder);
    else st.pendingOps.push(op);
  }

  private scheduleFlush(st: SessionState) {
    if (st.flushTimer || st.queued.length === 0) return;
    st.flushTimer = setTimeout(() => {
      st.flushTimer = null;
      this.flush(st);
    }, this.deps.flushDelayMs ?? 25);
  }

  private flush(st: SessionState) {
    if (st.dead || !st.builder || st.queued.length === 0) return;
    for (const call of st.queued.splice(0)) {
      st.builder.toolCall(call.id, call.name, call.args);
      st.parked.set(call.id, call.resolve);
    }
    this.complete(st, { kind: "done", reason: "toolUse" });
  }

  private failParked(st: SessionState, text: string) {
    const err: McpToolResult = { content: [{ type: "text", text }], isError: true };
    for (const resolve of st.parked.values()) resolve(err);
    for (const call of st.queued) call.resolve(err);
    st.parked.clear();
    st.queued = [];
  }

  private abort(st: SessionState) {
    if (st.dead) return;
    st.acp.notify("session/cancel", { sessionId: st.sessionId });
    this.complete(st, { kind: "error", reason: "aborted", message: "Aborted" });
    this.discard(st);
  }

  private discard(st: SessionState, cancel = false) {
    if (st.dead) return;
    if (cancel && st.promptActive) st.acp.notify("session/cancel", { sessionId: st.sessionId });
    st.dead = true;
    if (st.flushTimer) clearTimeout(st.flushTimer);
    this.failParked(st, "The Pi turn was cancelled.");
    st.detachAbort?.();
    if (this.states.get(st.key) === st) this.states.delete(st.key);
    this.bySessionId.delete(st.sessionId);
  }

  private wire(acp: AcpLike) {
    if (this.wired.has(acp)) return;
    this.wired.add(acp);
    acp.onNotification((method, params) => {
      if (method !== "session/update") return;
      const st = this.bySessionId.get(params?.sessionId);
      const update = params?.update;
      if (!st || st.dead || !update) return;
      const text = update.content?.type === "text" ? String(update.content.text ?? "") : "";
      if (update.sessionUpdate === "agent_message_chunk") this.apply(st, (b) => b.delta("text", text));
      else if (update.sessionUpdate === "agent_thought_chunk") this.apply(st, (b) => b.delta("thinking", text));
    });
    acp.onRequest(async (method, params) => {
      if (method === "session/request_permission") {
        const name = String(params?.toolCall?.name ?? "");
        const option = pickOption(params?.options ?? [], name.startsWith("mcp_pi_") ? "allow" : "reject");
        return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
      }
      throw new Error(`${method} is not supported by pi-antigravity-bridge`);
    });
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as any).message);
  return String(err);
}
