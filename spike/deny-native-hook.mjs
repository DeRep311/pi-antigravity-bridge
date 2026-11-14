// PreToolUse hook: allow only MCP tools (Pi tools), deny every native agy tool. Logs inputs to $HOOK_LOG.
import { appendFileSync, readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const name = String(input.toolCall?.name ?? "");
const allow = /^mcp/i.test(name);
if (process.env.HOOK_LOG) appendFileSync(process.env.HOOK_LOG, JSON.stringify({ name, allow, args: input.toolCall?.args }) + "\n");
process.stdout.write(JSON.stringify(allow
  ? { decision: "allow" }
  : { decision: "deny", reason: `Native tool ${name} is disabled in this environment. Use the provided mcp_pi_* tools instead.` }));
