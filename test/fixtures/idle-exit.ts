// Uses AcpClient and a relay, then goes idle without calling kill(): the process must exit on its own.
import { fileURLToPath } from "node:url";
import { AcpClient } from "../../src/acp.ts";
import { startRelay } from "../../src/relay.ts";

const fake = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
const client = new AcpClient({ command: process.execPath, args: [fake] });
const acp = await client.getAcp();
await acp.request("echo", { a: 1 });
const relay = await startRelay({ toolsFor: () => [], handleToolCall: async () => ({ content: [], isError: false }) } as any);
process.stdout.write(`IDLE ${relay.path}\n`);
