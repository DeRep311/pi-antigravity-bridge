// agy PreToolUse hook: allow only Pi tools bridged over MCP (prefix from PI_AGY_ALLOWED_PREFIX), deny everything else.
// Never fails open: any error, malformed input or missing prefix results in a deny decision and exit 0.
import { readFileSync } from "node:fs";

function decide() {
  const prefix = process.env.PI_AGY_ALLOWED_PREFIX;
  let name;
  try { name = JSON.parse(readFileSync(0, "utf8"))?.toolCall?.name; } catch { name = undefined; }
  const allowed = typeof prefix === "string" && prefix !== "" && typeof name === "string"
    && name.startsWith(prefix) && /^[A-Za-z0-9_.-]+$/.test(name.slice(prefix.length));
  if (allowed) return { decision: "allow" };
  const label = typeof name === "string" && /^[\x20-\x7e]{1,80}$/.test(name) ? name : "(unknown)";
  const hint = typeof prefix === "string" && prefix !== "" ? `${prefix}*` : "the provided Pi";
  return { decision: "deny", reason: `Native tool ${label} is disabled in this environment. Use the provided ${hint} tools instead.` };
}

let out;
try { out = decide(); } catch { out = { decision: "deny", reason: "Tool denied by the Pi guard." }; }
process.stdout.write(JSON.stringify(out));
process.exitCode = 0;
