// Converting the Pi transcript into agy ACP prompt blocks, and digesting it to detect divergence.
import { createHash } from "node:crypto";
import type { ImageBlock, PiMessage, TextBlock } from "./types.ts";

export type PromptBlock = TextBlock | ImageBlock;

export function toolPolicy(prefix: string): string {
  return [
  "<tool_policy>",
  "You are running as a model inside the Pi coding harness. Your built-in tools (file edits, shell, browser, search, subagents) are disabled and every call to them is denied.",
  "Use ONLY the tools whose names start with `" + prefix + "`; they are the harness tools described in the system instructions (for example `read` is `" + prefix + "read`).",
  "</tool_policy>",
].join("\n");
}

/** Stable digest of the content Pi and agy share; ignores timestamps, usage and other metadata. */
export function digestMessages(messages: PiMessage[]): string {
  const hash = createHash("sha256");
  for (const m of messages) {
    const shape = m.role === "toolResult"
      ? { role: m.role, toolCallId: m.toolCallId, content: m.content, isError: m.isError }
      : { role: m.role, content: m.content };
    hash.update(JSON.stringify(shape));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function userBlocks(content: PiMessage["content"]): PromptBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: PromptBlock[] = [];
  for (const b of content as { type: string }[]) {
    if (b.type === "text") blocks.push({ type: "text", text: (b as TextBlock).text });
    else if (b.type === "image") blocks.push({ type: "image", data: (b as ImageBlock).data, mimeType: (b as ImageBlock).mimeType });
  }
  return blocks;
}

function textOf(content: PiMessage["content"]): string {
  return userBlocks(content).map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("\n");
}

function renderHistoryEntry(m: PiMessage, toolNames: Map<string, string>): string {
  if (m.role === "user") return `[user]\n${textOf(m.content)}`;
  if (m.role === "toolResult") {
    const name = toolNames.get(m.toolCallId) ?? m.toolName;
    return `[tool_result ${name}${m.isError ? " (error)" : ""}]\n${textOf(m.content)}`;
  }
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === "text" && b.text) parts.push(`[assistant]\n${b.text}`);
    else if (b.type === "toolCall") {
      toolNames.set(b.id, b.name);
      parts.push(`[tool_call ${b.name}] ${JSON.stringify(b.arguments ?? {})}`);
    }
  }
  return parts.join("\n");
}

/**
 * Prompt for a fresh agy session: system instructions, tool policy, prior history as text and the
 * trailing user message(s) as live blocks. A transcript that ends in tool results asks agy to continue.
 */
export function renderReplayPrompt(systemPrompt: string, messages: PiMessage[], prefix: string): PromptBlock[] {
  let tail = messages.length;
  while (tail > 0 && messages[tail - 1].role === "user") tail--;
  const history = messages.slice(0, tail);
  const trailing = messages.slice(tail);

  const toolNames = new Map<string, string>();
  const header = [
    `<system_instructions>\n${systemPrompt}\n</system_instructions>`,
    toolPolicy(prefix),
  ];
  if (history.length > 0) {
    const rendered = history.map((m) => renderHistoryEntry(m, toolNames)).filter(Boolean).join("\n\n");
    header.push(`<conversation_history>\n${rendered}\n</conversation_history>`);
  }
  const blocks: PromptBlock[] = [{ type: "text", text: header.join("\n\n") }];
  if (trailing.length > 0) blocks.push(...renderNewUserMessages(trailing));
  else blocks.push({ type: "text", text: "Continue the task from the last tool result above." });
  return blocks;
}

/** Blocks for user messages appended to an existing agy session. */
export function renderNewUserMessages(messages: PiMessage[]): PromptBlock[] {
  return messages.flatMap((m) => (m.role === "user" ? userBlocks(m.content) : []));
}
