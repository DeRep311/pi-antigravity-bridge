import { test } from "node:test";
import assert from "node:assert/strict";
import { digestMessages, renderReplayPrompt, renderNewUserMessages, toolPolicy } from "../src/transcript.ts";
import type { PiMessage } from "../src/types.ts";

const user = (text: string): PiMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string, extra: object[] = []): PiMessage => ({
  role: "assistant", content: [{ type: "text", text }, ...extra], timestamp: 2,
} as PiMessage);
const toolResult = (id: string, text: string, isError = false): PiMessage => ({
  role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError, timestamp: 3,
} as PiMessage);

test("digest ignores timestamps and usage but not content", () => {
  const a = digestMessages([user("hi"), assistant("yo")]);
  const b = digestMessages([{ ...user("hi"), timestamp: 99 }, { ...assistant("yo"), timestamp: 42, usage: { x: 1 } } as PiMessage]);
  const c = digestMessages([user("hi"), assistant("yo!")]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("replay prompt carries system prompt, tool policy, history and the last user message", () => {
  const blocks = renderReplayPrompt("SYS RULES", [
    user("first"),
    assistant("calling", [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }]),
    toolResult("t1", "file body"),
    assistant("done"),
    user("second question"),
  ], "mcp_pix_");
  const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  assert.match(text, /<system_instructions>\nSYS RULES\n<\/system_instructions>/);
  assert.ok(text.includes(toolPolicy("mcp_pix_")));
  assert.ok(text.includes("`mcp_pix_`") && !text.includes("mcp_pi_"));
  assert.match(text, /<conversation_history>[\s\S]*\[user\]\nfirst[\s\S]*\[tool_call read\] \{"path":"a.ts"\}[\s\S]*\[tool_result read\]\nfile body[\s\S]*\[assistant\]\ndone[\s\S]*<\/conversation_history>/);
  assert.ok(text.trimEnd().endsWith("second question"));
  assert.ok(!/<conversation_history>[\s\S]*second question[\s\S]*<\/conversation_history>/.test(text));
});

test("replay ending in tool results asks the model to continue from them", () => {
  const blocks = renderReplayPrompt("S", [user("go"), assistant("", [{ type: "toolCall", id: "t1", name: "read", arguments: {} }]), toolResult("t1", "boom", true)], "mcp_pix_");
  const text = blocks.map((b) => (b as { text?: string }).text ?? "").join("\n");
  assert.match(text, /\[tool_result read \(error\)\]\nboom/);
  assert.match(text, /Continue the task from the last tool result above\.$/);
});

test("new user messages render text and keep images as image blocks", () => {
  const blocks = renderNewUserMessages([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 } as PiMessage,
    user("and this"),
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "look" },
    { type: "image", data: "AAA", mimeType: "image/png" },
    { type: "text", text: "and this" },
  ]);
});
