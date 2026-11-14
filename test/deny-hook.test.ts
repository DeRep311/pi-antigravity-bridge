import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = process.env.PI_TEST_HOOK ?? fileURLToPath(new URL("../src/deny-native-hook.mjs", import.meta.url));
const PREFIX = "mcp_pi1a2b3c4d_";

function run(stdin: string, ...rest: [string?]) {
  const prefix = rest.length ? rest[0] : PREFIX;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PI_AGY_ALLOWED_PREFIX;
  if (prefix !== undefined) env.PI_AGY_ALLOWED_PREFIX = prefix;
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const call = (name: unknown) => JSON.stringify({ toolCall: { name, args: {} } });

test("hook denies malformed, hostile or foreign input and always exits 0", () => {
  const cases: [string, string][] = [
    ["empty", ""], ["not json", "not json"], ["null", "null"], ["array", "[1]"], ["empty object", "{}"],
    ["null toolCall", '{"toolCall":null}'],
    ["array name", JSON.stringify({ toolCall: { name: [`${PREFIX}x`] } })],
    ["bare prefix", call(PREFIX)],
    ["prefix + newline", call(`${PREFIX}bash\nrm`)],
    ["native write", call("write_file")],
    ["other server tool", call("mcp_other_bash")],
    ["guessable old prefix", call("mcp_pi_bash")],
  ];
  for (const [label, stdin] of cases) {
    const r = run(stdin);
    assert.equal(r.status, 0, label);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "deny", label);
    assert.equal(typeof out.reason, "string", label);
  }
});

test("hook allows a real Pi tool name under the configured prefix", () => {
  const r = run(call(`${PREFIX}bash`));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { decision: "allow" });
});

test("hook with no prefix configured (or an empty one) denies everything", () => {
  for (const prefix of [undefined, ""] as (string | undefined)[]) {
    for (const name of [`${PREFIX}bash`, "mcp_pi_bash", "bash"]) {
      const r = run(call(name), prefix as string | undefined);
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).decision, "deny");
    }
  }
});
