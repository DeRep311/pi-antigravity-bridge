// Starts isolation + relay + AcpClient (fake agy) wired like src/index.ts, prints their locations, then waits.
// SIGNAL_HOST_OWN=<signal> installs a host listener first (as Pi does for SIGINT); it exits on the second signal.
import { fileURLToPath } from "node:url";
import { AcpClient } from "../../src/acp.ts";
import { createIsolation } from "../../src/isolation.ts";
import { startRelay } from "../../src/relay.ts";
import { onTerminate } from "../../src/signals.ts";

let hostSignals = 0;
if (process.env.SIGNAL_HOST_OWN) process.on(process.env.SIGNAL_HOST_OWN as NodeJS.Signals, () => {
  process.stdout.write("HOST-HANDLER\n");
  if (++hostSignals >= 2) process.exit(0);
});
const fake = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
const iso = createIsolation();
const client = new AcpClient({ command: process.execPath, args: [fake] });
const acp = await client.getAcp();
const { pid } = await acp.request("pid", {});
const relay = await startRelay({ toolsFor: () => [], handleToolCall: async () => ({ content: [], isError: false }) } as any);
process.removeListener("exit", iso.cleanup);
onTerminate(() => { client.kill("SIGKILL"); iso.cleanup(); relay.cleanupSync(); });
process.once("exit", () => { client.kill("SIGKILL"); iso.cleanup(); relay.cleanupSync(); });
process.stdout.write(`READY ${JSON.stringify({ iso: iso.dir, sock: relay.path, pid })}\n`);
setInterval(() => {}, 1000);
