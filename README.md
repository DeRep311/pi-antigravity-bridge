# pi-antigravity-bridge

Use **Gemini models inside [Pi](https://github.com/earendil-works/pi) and Gentle Shell** through the official **Antigravity CLI (`agy`)**: assign Gemini to any phase or subagent (apply/worker, explore, verify…) while Pi keeps running the tools, guards and workflow.

- No API key and no token handling: authentication stays inside your signed-in `agy`.
- Pi tools only: agy's own tools (file edits, shell, browser…) are denied, so every action still goes through Pi.
- Your personal agy settings are never used or modified.

> Unofficial community project, not affiliated with Google. You are responsible for using Antigravity according to its terms of service.

## Quick path

1. **Install and sign in to `agy`**: run `agy` once and sign in with Google. `agy models` should list Gemini models.
2. **Install the package**:
   ```bash
   pi install git:github.com/DeRep311/pi-antigravity-bridge
   # Gentle Shell: PI_CODING_AGENT_DIR=~/.gentle-shell/agent pi install git:github.com/DeRep311/pi-antigravity-bridge
   ```
3. **Check it works**:
   ```bash
   pi --no-session --model antigravity-bridge/gemini-3.8-flash -p "Reply with exactly: PONG"
   ```
   Expected output: `PONG`.

## Models

| Pi model id | agy family |
|-------------|------------|
| `antigravity-bridge/gemini-4-argon` | Gemini 4 Argon |
| `antigravity-bridge/gemini-4-hydrogen` | Gemini 4 Hydrogen |
| `antigravity-bridge/gemini-3.8-flash` | Gemini 3.8 Flash |

Effort comes from Pi's thinking level (`--thinking`, or a subagent's effort) and selects the agy variant:

| Pi thinking level | agy variant |
|-------------------|-------------|
| `off`, `minimal`, `low` | `-low` |
| `medium` (default) | `-medium` |
| `high` | `-high` |
| `xhigh`, `max` | `-xhigh` if the family has it, otherwise the nearest lower level |

You can also pass an exact agy id, such as `antigravity-bridge/gemini-4-argon-high`; it is used as is.

## Assign Gemini to a Gentle Shell phase or subagent

Subagent models come from the active profile, not from `subagents.json`.

1. Run `/gentle:profiles` and open the profile you use (for example `current`).
2. Select the agent row (for example `gentle-ai-worker`), press `enter` on **Model**, choose **Custom model id…** and enter `antigravity-bridge/gemini-4-argon`.
3. Press `e` to pick the effort, then `s` to save.
4. Press `d` (**Make default**) so new sessions use it, or `u` to use it only in the current session.

A running session keeps the profile it started with: restart it, or use `u`, to pick up the change.

## How it works

```
Pi (streamSimple) ──ACP JSON-RPC──▶ agy acp --gemini-dir <temp dir>
      ▲                                   │ Gemini wants a tool
      │ tool result                       ▼
      └──── Pi runs the tool ◀── toolUse ◀── MCP shim (mcp_pi_<tool>) ◀── agy
```

| Piece | What it does |
|-------|--------------|
| `src/engine.ts` | Maps each Pi session to an agy ACP session; streams text and thinking; turns MCP tool calls into Pi tool calls and resumes agy with Pi's results. |
| `src/mcp-shim.mjs`, `src/relay.ts` | Stdio MCP server that agy starts per session; it forwards `tools/list` and `tools/call` to the bridge over a Unix socket. |
| `src/isolation.ts`, `src/deny-native-hook.mjs` | Temporary agy config directory with a `PreToolUse` hook that only allows the bridge's own MCP tools (`mcp_<random server name>_*`; the server name is regenerated per Pi process). It is deleted on exit and when SIGTERM, SIGINT or SIGHUP terminates Pi. |
| `src/schema.ts` | Rewrites Pi tool schemas into the JSON Schema subset Gemini accepts (string-only enums). |

## Limits

- The model catalog is static: the three families above. Exact agy ids still work.
- When Pi rewrites history (compaction, edits, branching), the bridge opens a fresh agy session and replays the transcript as text.
- One `agy acp` process runs per Pi process and is stopped when Pi exits or is terminated by SIGTERM, SIGINT or SIGHUP (not SIGKILL, which cannot be caught). A signal that Pi handles itself, such as SIGINT interrupting a turn, leaves agy and its config in place.
- Tool calls have been tested up to 70 seconds. agy has an MCP timeout whose default is unknown, so very long tools may be cut off.
- The environment of Pi is passed through to `agy`, and the deny hook and MCP shim run with the same Node binary as Pi (`process.execPath`).
- If `agy` itself fails, the last ~2 KB of its stderr is appended to the error message.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `You are not logged into Antigravity` | Run `agy` and sign in, then retry. |
| `spawn agy ENOENT` (or `agy: command not found`) | Install the Antigravity CLI, or set `PI_AGY_BIN=/path/to/agy`. |
| A subagent still uses its old model | Set it in `/gentle:profiles` and press `d`, then start a new session. |
| Gemini rejects a request with `INVALID_ARGUMENT … parameters` | A tool schema uses a construct Gemini does not support; open an issue with the message. |

## Development

```bash
npm test          # node --test, no dependencies needed (Node >= 22.18)
pi -e ./src/index.ts --no-session --model antigravity-bridge/gemini-3.8-flash -p "Reply with exactly: PONG"
```

`spike/` holds the probe scripts that proved the ACP transport, the MCP tool bridge and the native-tool denial.

## License

MIT
