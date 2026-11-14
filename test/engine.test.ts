import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeEngine } from "../src/engine.ts";
import type { AcpLike, EventSink, PiMessage, StreamInput } from "../src/types.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
const defer = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const AVAILABLE = ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"];

class FakeAcp implements AcpLike {
  requests: { method: string; params: any }[] = [];
  notifications: { method: string; params: any }[] = [];
  prompts: Deferred<any>[] = [];
  sessions = 0;
  private onNote?: (method: string, params: any) => void;
  private onReq?: (method: string, params: any) => Promise<any>;
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === "session/new") return { sessionId: `s${++this.sessions}`, models: { availableModels: AVAILABLE.map((modelId) => ({ modelId })) } };
    if (method === "session/prompt") { const d = defer<any>(); this.prompts.push(d); return d.promise; }
    return {};
  }
  notify(method: string, params: any) { this.notifications.push({ method, params }); }
  onNotification(h: (method: string, params: any) => void) { this.onNote = h; }
  onRequest(h: (method: string, params: any) => Promise<any>) { this.onReq = h; }
  update(sessionId: string, update: object) { this.onNote?.("session/update", { sessionId, update }); }
  clientRequest(method: string, params: any) { return this.onReq!(method, params); }
  methods() { return this.requests.map((r) => r.method); }
}

class Sink implements EventSink {
  events: any[] = [];
  ended = false;
  push(e: any) { this.events.push(e); }
  end() { this.ended = true; }
  types() { return this.events.map((e) => e.type); }
  last() { return this.events.at(-1); }
}

function setup() {
  const acp = new FakeAcp();
  const engine = new BridgeEngine({
    getAcp: async () => acp,
    mcpServer: (key) => ({ name: "pi", command: "node", args: ["shim.mjs"], env: [{ name: "PI_AGY_KEY", value: key }] }),
    provider: "antigravity-bridge",
    api: "antigravity-bridge",
    now: () => 1000,
    flushDelayMs: 0,
  });
  return { acp, engine };
}

const user = (text: string): PiMessage => ({ role: "user", content: text, timestamp: 1 });
const input = (messages: PiMessage[], over: Partial<StreamInput> = {}): StreamInput => ({
  key: "k1", modelId: "gemini-4-argon", reasoning: "high", systemPrompt: "SYS", tools: [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ], messages, cwd: "/work", ...over,
});

test("text turn: creates a session, selects the variant, streams thinking and text, ends with stop", async () => {
  const { acp, engine } = setup();
  const sink = new Sink();
  engine.stream(input([user("hello")]), sink);
  await tick();
  assert.deepEqual(acp.methods(), ["session/new", "session/set_model", "session/prompt"]);
  assert.equal(acp.requests[0].params.cwd, "/work");
  assert.deepEqual(acp.requests[0].params.mcpServers[0].env, [{ name: "PI_AGY_KEY", value: "k1" }]);
  assert.deepEqual(acp.requests[1].params, { sessionId: "s1", modelId: "gemini-4-argon-high" });
  const promptText = acp.requests[2].params.prompt.map((b: any) => b.text).join("\n");
  assert.match(promptText, /SYS/);
  assert.ok(promptText.trimEnd().endsWith("hello"));

  acp.update("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  acp.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } });
  acp.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
  acp.prompts[0].resolve({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 3, cachedWriteTokens: 0, thoughtTokens: 2, totalTokens: 17 } });
  await tick();

  assert.deepEqual(sink.types(), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  assert.equal(sink.ended, true);
  const done = sink.last();
  assert.equal(done.reason, "stop");
  assert.deepEqual(done.message.content, [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hi there" }]);
  assert.equal(done.message.model, "gemini-4-argon");
  assert.equal(done.message.provider, "antigravity-bridge");
  assert.equal(done.message.stopReason, "stop");
  assert.deepEqual(done.message.usage, { input: 10, output: 4, cacheRead: 3, cacheWrite: 0, reasoning: 2, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
});

test("tools are listable while agy is still creating the session (tools/list during session/new)", async () => {
  const { acp, engine } = setup();
  let listed: unknown[] = [];
  const original = acp.request.bind(acp);
  acp.request = async (method: string, params: any) => {
    if (method === "session/new") listed = engine.toolsFor("k1");
    return original(method, params);
  };
  engine.stream(input([user("hi")]), new Sink());
  await tick();
  assert.deepEqual(listed, [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]);
});

test("tool schemas are sanitized for Gemini before agy lists them", async () => {
  const { engine } = setup();
  engine.stream(input([user("hi")], { tools: [{ name: "review", description: "r", parameters: { type: "object", properties: { committedOnly: { enum: [true], type: "boolean" } } } }] }), new Sink());
  await tick();
  assert.deepEqual(engine.toolsFor("k1"), [{ name: "review", description: "r", inputSchema: { type: "object", properties: { committedOnly: { type: "boolean" } } } }]);
});

test("tool loop: parks the MCP call, ends with toolUse, resumes with Pi's tool result on the next call", async () => {
  const { acp, engine } = setup();
  const first = new Sink();
  engine.stream(input([user("read a.ts")]), first);
  await tick();
  const result = engine.handleToolCall("k1", "read", { path: "a.ts" });
  await tick();

  assert.deepEqual(first.types(), ["start", "toolcall_start", "toolcall_end", "done"]);
  const done = first.last();
  assert.equal(done.reason, "toolUse");
  const call = done.message.content[0];
  assert.equal(call.type, "toolCall");
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "a.ts" });

  const second = new Sink();
  engine.stream(input([user("read a.ts"), done.message, {
    role: "toolResult", toolCallId: call.id, toolName: "read", content: [{ type: "text", text: "export {}" }], isError: false, timestamp: 5,
  } as PiMessage]), second);
  assert.deepEqual(await result, { content: [{ type: "text", text: "export {}" }], isError: false });

  acp.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It is empty." } });
  acp.prompts[0].resolve({ stopReason: "end_turn" });
  await tick();
  assert.deepEqual(acp.methods(), ["session/new", "session/set_model", "session/prompt"], "no new session or prompt while resuming");
  assert.deepEqual(second.types(), ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.equal(second.last().reason, "stop");
});

test("parallel MCP calls arriving together are emitted as one toolUse turn", async () => {
  const { engine } = setup();
  const sink = new Sink();
  engine.stream(input([user("read both")]), sink);
  await tick();
  engine.handleToolCall("k1", "read", { path: "a" });
  engine.handleToolCall("k1", "read", { path: "b" });
  await tick();
  assert.deepEqual(sink.types(), ["start", "toolcall_start", "toolcall_end", "toolcall_start", "toolcall_end", "done"]);
  assert.equal(sink.last().message.content.length, 2);
});

test("follow-up user turn reuses the session and sends only the new message", async () => {
  const { acp, engine } = setup();
  const first = new Sink();
  engine.stream(input([user("one")]), first);
  await tick();
  acp.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
  acp.prompts[0].resolve({ stopReason: "end_turn" });
  await tick();

  const second = new Sink();
  engine.stream(input([user("one"), first.last().message, user("two")]), second);
  await tick();
  assert.deepEqual(acp.methods(), ["session/new", "session/set_model", "session/prompt", "session/prompt"]);
  assert.deepEqual(acp.requests[3].params.prompt, [{ type: "text", text: "two" }]);
});

test("diverged history (edited or compacted) starts a fresh session and replays it", async () => {
  const { acp, engine } = setup();
  const first = new Sink();
  engine.stream(input([user("one")]), first);
  await tick();
  acp.prompts[0].resolve({ stopReason: "end_turn" });
  await tick();

  engine.stream(input([user("summary of earlier work"), user("two")]), new Sink());
  await tick();
  assert.deepEqual(acp.methods().slice(3), ["session/new", "session/set_model", "session/prompt"]);
  const replay = acp.requests[5].params.prompt.map((b: any) => b.text).join("\n");
  assert.match(replay, /summary of earlier work/);
});

test("abort cancels the agy turn and ends the stream with an aborted error", async () => {
  const { acp, engine } = setup();
  const ctrl = new AbortController();
  const sink = new Sink();
  engine.stream(input([user("long task")], { signal: ctrl.signal }), sink);
  await tick();
  ctrl.abort();
  await tick();
  assert.deepEqual(acp.notifications, [{ method: "session/cancel", params: { sessionId: "s1" } }]);
  assert.equal(sink.last().type, "error");
  assert.equal(sink.last().reason, "aborted");
  assert.equal(sink.ended, true);
});

test("agy prompt failure ends the stream with an error message", async () => {
  const { acp, engine } = setup();
  const sink = new Sink();
  engine.stream(input([user("x")]), sink);
  await tick();
  acp.prompts[0].reject(new Error("quota exhausted"));
  await tick();
  assert.equal(sink.last().type, "error");
  assert.equal(sink.last().reason, "error");
  assert.match(sink.last().error.errorMessage, /quota exhausted/);
});

test("permission requests: Pi MCP tools are allowed once, everything else is rejected", async () => {
  const { acp, engine } = setup();
  engine.stream(input([user("x")]), new Sink());
  await tick();
  const options = [
    { optionId: "a1", kind: "allow_once" }, { optionId: "a2", kind: "allow_always" },
    { optionId: "r1", kind: "reject_once" }, { optionId: "r2", kind: "reject_always" },
  ];
  assert.deepEqual(await acp.clientRequest("session/request_permission", { sessionId: "s1", toolCall: { name: "mcp_pi_read" }, options }),
    { outcome: { outcome: "selected", optionId: "a1" } });
  assert.deepEqual(await acp.clientRequest("session/request_permission", { sessionId: "s1", toolCall: { name: "write_file" }, options }),
    { outcome: { outcome: "selected", optionId: "r1" } });
  await assert.rejects(acp.clientRequest("fs/write_text_file", { path: "/etc/x" }), /not supported/);
});
