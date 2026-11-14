import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSchema } from "../src/schema.ts";

test("drops enums with non-string values and keeps the type (Gemini only accepts string enums)", () => {
  const out = sanitizeSchema({
    type: "object",
    properties: {
      committedOnly: { enum: [true], type: "boolean" },
      level: { type: "integer", enum: [1, 2, 3] },
      mode: { type: "string", enum: ["a", "b"] },
    },
  });
  assert.deepEqual(out, {
    type: "object",
    properties: {
      committedOnly: { type: "boolean" },
      level: { type: "integer" },
      mode: { type: "string", enum: ["a", "b"] },
    },
  });
});

test("infers the type of a dropped enum when the schema had none, and removes empty enums", () => {
  assert.deepEqual(sanitizeSchema({ enum: [true] }), { type: "boolean" });
  assert.deepEqual(sanitizeSchema({ enum: [3] }), { type: "number" });
  assert.deepEqual(sanitizeSchema({ type: "string", enum: [] }), { type: "string" });
});

test("rewrites const into a single-value string enum or drops it", () => {
  assert.deepEqual(sanitizeSchema({ const: "x" }), { type: "string", enum: ["x"] });
  assert.deepEqual(sanitizeSchema({ type: "boolean", const: true }), { type: "boolean" });
});

test("recurses through items, anyOf/oneOf/allOf, additionalProperties and $defs without mutating input", () => {
  const input = {
    type: "object",
    properties: {
      list: { type: "array", items: { enum: [false] } },
      choice: { anyOf: [{ enum: [1] }, { type: "string", enum: ["k"] }] },
      map: { type: "object", additionalProperties: { const: 2 } },
    },
    $defs: { flag: { enum: [true] } },
  };
  const before = JSON.stringify(input);
  const out = sanitizeSchema(input) as any;
  assert.deepEqual(out.properties.list.items, { type: "boolean" });
  assert.deepEqual(out.properties.choice.anyOf, [{ type: "number" }, { type: "string", enum: ["k"] }]);
  assert.deepEqual(out.properties.map.additionalProperties, { type: "number" });
  assert.deepEqual(out.$defs.flag, { type: "boolean" });
  assert.equal(JSON.stringify(input), before);
});

test("does not treat a property literally named enum or const as a keyword", () => {
  const schema = { type: "object", properties: { enum: { type: "string" }, const: { type: "number" } }, required: ["enum"] };
  assert.deepEqual(sanitizeSchema(schema), schema);
});
