// agy PreToolUse hook: allow only Pi tools bridged over MCP (mcp_pi_*), deny every native agy tool.
import { readFileSync } from "node:fs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* treat as unknown tool */ }
const name = String(input.toolCall?.name ?? "");
const allow = /^mcp_pi_/.test(name);
process.stdout.write(JSON.stringify(allow
  ? { decision: "allow" }
  : { decision: "deny", reason: `Native tool ${name || "(unknown)"} is disabled in this environment. Use the provided mcp_pi_* tools instead.` }));
