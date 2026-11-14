import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIsolation } from "../src/isolation.ts";

test("isolated gemini dir has hooks.json with a PreToolUse '*' hook; cleanup removes it", () => {
  const iso = createIsolation();
  try {
    assert.ok(iso.dir.startsWith(tmpdir()));
    const hooks = JSON.parse(readFileSync(join(iso.dir, "config", "hooks.json"), "utf8"));
    const entry = hooks["pi-guard"].PreToolUse;
    assert.equal(entry.length, 1);
    assert.equal(entry[0].matcher, "*");
    assert.equal(entry[0].hooks.length, 1);
    assert.equal(entry[0].hooks[0].timeout, 10);
    assert.ok(entry[0].hooks[0].command.includes(process.execPath));
    assert.ok(entry[0].hooks[0].command.includes("deny-native-hook.mjs"));

    const run = (name: string) => {
      const r = spawnSync("sh", ["-c", entry[0].hooks[0].command], { input: JSON.stringify({ toolCall: { name, args: {} } }), encoding: "utf8" });
      assert.equal(r.status, 0);
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(run("mcp_pi_read"), { decision: "allow" });
    const denied = run("write_file");
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /mcp_pi_/);
    assert.equal(run("mcp_other_tool").decision, "deny");
    assert.equal(run("run_command").decision, "deny");
  } finally { iso.cleanup(); }
  assert.equal(existsSync(iso.dir), false);
});
