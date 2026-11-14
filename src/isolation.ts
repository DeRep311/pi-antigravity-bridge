// Isolated agy config dir: no inherited user settings, native tools denied by a PreToolUse hook.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = fileURLToPath(new URL("./deny-native-hook.mjs", import.meta.url));

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type Isolation = { dir: string; cleanup(): void };

export function createIsolation(opts: { hookScript?: string; allowedPrefix?: string } = {}): Isolation {
  const dir = mkdtempSync(join(tmpdir(), "pi-agy-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  const command = `PI_AGY_ALLOWED_PREFIX=${shq(opts.allowedPrefix ?? "")} ${shq(process.execPath)} ${shq(opts.hookScript ?? HOOK_SCRIPT)}`;
  const hooks = { "pi-guard": { PreToolUse: [{ matcher: "*", hooks: [{ command, timeout: 10 }] }] } };
  writeFileSync(join(dir, "config", "hooks.json"), JSON.stringify(hooks, null, 2));
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    process.removeListener("exit", cleanup);
    rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", cleanup);
  return { dir, cleanup };
}
