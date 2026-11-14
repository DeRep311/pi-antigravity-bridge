# antigravity-bridge

Pi provider extension (`pi-antigravity-bridge`) that exposes Gemini models by driving the official Antigravity CLI (`agy`) headless, so Gentle Shell phases/subagents can be assigned Gemini models.
Pattern reference: `~/.gentle-shell/agent/npm/node_modules/pi-claude-bridge` (provider + streamSimple + in-process MCP for Pi tools).

## Specs

- S1. Gemini must be assignable as a model to any phase/subagent: "la idea es que pueda asignarle un modelo a una de las fases como de apply o cualquiera con gemini, despues como lo llame no me importa pero quiero que este integrado con esto". Target usage: `~/.gentle-shell/agent/subagents.json` → `"gentle-ai-worker": {"model": "antigravity-bridge/<agy-model-id>"}`.
- S2. It must be a provider that calls the agy CLI: "no podemos usarlo con agy? osea simular el bridge con los providers pero que llame las cli de agy?" / "igual como proveedor pero no podemos usar el agy merido?". Auth stays with the official `agy` binary; the bridge never reads or extracts tokens ("usariamos agy que es la herramienta oficial osea no violamos servicios").
- S3. Integration with the harness: Pi tools execute through Pi (edit surfaces, ODD, review); agy native tools (run_command, write_to_file, replace_file_content, view_file, browser_*, …) must not act on their own. The bridge must not inherit the user's global agy settings (`toolPermission: always-proceed`, `agentMode: accept-edits`).

## Tasks

- T1 [S2,S3] Spike: prove (a) native tools can be disabled headless, (b) MCP tool calls are observable/pausable in stream-json, (c) isolated config dir. Route: inline. Commit: —
- T2 [S1,S2] Package scaffold, provider registration, model catalog from `agy models`. Route: inline. Commit: —
- T3 [S1,S2] streamSimple text turns over agy stream-json (text/thinking deltas, usage, errors). Route: inline. Commit: —
- T4 [S3] Pi tools exposed to agy via MCP bridge; tool calls returned to Pi's loop and results resumed. Route: inline. Commit: —
- T5 [S1,S3] Effort mapping, timeouts/aborts, isolated config, native tools denied. Route: inline. Commit: —
- T6 [S1] Install into Gentle Shell, README, subagents.json example, end-to-end check with a subagent. Route: inline. Commit: —

## Log

- L1 (user, original request): "Mira necesitaría lograr conectar Gémini con Gentle Shell no sé si envolver todo en una CLI acordémonos que Gemini tiene Gemini CLI y tiene anti-gravity CLI y anti-gravity sdk entonces quiero que se podamos usar alguna de esas cosas para nada para poder ponerlo en esto no tipo para poder conectarlo y poder llamar delegar tareas con los agentes de Gemini"
- L2 (user): "mira, la idea es que pueda asignarle un modelo a una de las fases como de apply o cualquiera con gemini, despues como lo llame no me importa pero quiero que este integrado con esto"
- L3 (user): "no podemos usarlo con agy? osea simular el bridge con los providers pero que llame las cli de agy?" + "igual como proveedor pero no podemos usar el agy merido?"
- L4 (user): "sigo con dudas pero esto usariamos agy que es la herramienta oficial osea no violamos servicios"
- L5 (user): approved creating ~/Documentos/pi-antigravity-bridge and starting with the spike.
- L6 (evidence): agy 2026 binary supports `-p`, `--input-format/--output-format stream-json`, `--model`, `--effort`, `--mode`, `--sandbox`, `agy mcp add` (stdio/http); binary contains `permissions.deny`, `disabledTools`, `acp`. agy token lives in OS keyring. Pi has no Google OAuth; built-in `google` provider needs GEMINI_API_KEY.
