# antigravity-bridge

Pi provider extension (`pi-antigravity-bridge`) that exposes Gemini models by driving the official Antigravity CLI (`agy`) headless, so Gentle Shell phases/subagents can be assigned Gemini models.
Pattern reference: `~/.gentle-shell/agent/npm/node_modules/pi-claude-bridge` (provider + streamSimple + in-process MCP for Pi tools).

## Specs

- S1. Gemini must be assignable as a model to any phase/subagent: "la idea es que pueda asignarle un modelo a una de las fases como de apply o cualquiera con gemini, despues como lo llame no me importa pero quiero que este integrado con esto". Target usage: `~/.gentle-shell/agent/subagents.json` → `"gentle-ai-worker": {"model": "antigravity-bridge/<agy-model-id>"}`.
- S2. It must be a provider that calls the agy CLI: "no podemos usarlo con agy? osea simular el bridge con los providers pero que llame las cli de agy?" / "igual como proveedor pero no podemos usar el agy merido?". Auth stays with the official `agy` binary; the bridge never reads or extracts tokens ("usariamos agy que es la herramienta oficial osea no violamos servicios").
- S3. Integration with the harness: Pi tools execute through Pi (edit surfaces, ODD, review); agy native tools (run_command, write_to_file, replace_file_content, view_file, browser_*, …) must not act on their own. The bridge must not inherit the user's global agy settings (`toolPermission: always-proceed`, `agentMode: accept-edits`).

## Tasks

- [x] T1 [S2,S3] Spike: prove (a) native tools can be disabled headless, (b) MCP tool calls are observable/pausable in stream-json, (c) isolated config dir. Route: inline. Commit: (see git log, spike/)
- [x] T2 [S1,S2] Package scaffold + model catalog (base families, effort→variant via resolveVariant). Provider registration moves to T4 wiring. Route: inline. Commit: (core commit)
- [x] T3 [S1,S2] Turn engine (src/engine.ts): text/thinking deltas, usage, errors, abort, tool park/resume, follow-up reuse, divergence replay — unit-tested with fake ACP. Route: inline. Commit: (core commit)
- T4 [S3] Pi tools exposed to agy via MCP bridge; tool calls returned to Pi's loop and results resumed. Route: inline. Commit: —
- T5 [S1,S3] Effort mapping, timeouts/aborts, isolated config, native tools denied. Route: inline. Commit: —
- T6 [S1] Install into Gentle Shell, README, subagents.json example, end-to-end check with a subagent. Route: inline. Commit: —

## Log

- L1 (user, original request): "Mira necesitaría lograr conectar Gémini con Gentle Shell no sé si envolver todo en una CLI acordémonos que Gemini tiene Gemini CLI y tiene anti-gravity CLI y anti-gravity sdk entonces quiero que se podamos usar alguna de esas cosas para nada para poder ponerlo en esto no tipo para poder conectarlo y poder llamar delegar tareas con los agentes de Gemini"
- L2 (user): "mira, la idea es que pueda asignarle un modelo a una de las fases como de apply o cualquiera con gemini, despues como lo llame no me importa pero quiero que este integrado con esto"
- L3 (user): "no podemos usarlo con agy? osea simular el bridge con los providers pero que llame las cli de agy?" + "igual como proveedor pero no podemos usar el agy merido?"
- L4 (user): "sigo con dudas pero esto usariamos agy que es la herramienta oficial osea no violamos servicios"
- L5 (user): approved creating ~/Documentos/pi-antigravity-bridge and starting with the spike.
- L7 (evidence, T1): Transport chosen = `agy acp` (JSON-RPC over stdio), not `-p`. initialize → session/new {cwd, mcpServers:[stdio]} returns models/modes/configOptions (model, thought_level low|medium|high, mode default|accept-edits|auto|plan); session/set_model works; session/prompt streams session/update (agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, usage_update) and returns {stopReason, usage}. MCP tools surface as `mcp_<server>_<tool>` (e.g. mcp_pi_pi_echo) and reach the stdio server's tools/call after session/request_permission is answered with the allow_once option. Native tools: global user settings made write_file/run_command run unasked; `--gemini-dir <tmp>` isolates config (auth still works via keyring); permissions.deny in antigravity-cli/settings.json was NOT honored and write_file inside the workspace runs unasked even in mode default; a PreToolUse hook at `<gemini-dir>/config/hooks.json` with matcher "*" returning {"decision":"deny"} for non-mcp tools blocked write_file and run_command (no files created). Probe scripts: spike/acp-probe.mjs, spike/fake-mcp.mjs, spike/deny-native-hook.mjs.
- L6 (evidence): agy 2026 binary supports `-p`, `--input-format/--output-format stream-json`, `--model`, `--effort`, `--mode`, `--sandbox`, `agy mcp add` (stdio/http); binary contains `permissions.deny`, `disabledTools`, `acp`. agy token lives in OS keyring. Pi has no Google OAuth; built-in `google` provider needs GEMINI_API_KEY.
