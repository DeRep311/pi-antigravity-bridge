// Gemini function declarations accept a subset of JSON Schema: `enum` must list strings only.
// Pi tools are written for other providers (e.g. `committedOnly: { enum: [true] }`), and one invalid
// tool makes Gemini reject the whole request, so schemas are rewritten before agy sees them.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_SINGLE = ["items", "additionalProperties", "not", "if", "then", "else", "contains"];

function isObject(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOfValue(v: Json): string | undefined {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  return undefined;
}

/** Returns a sanitized deep copy; the input is not modified. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!isObject(schema)) return schema;
  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAPS.includes(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeSchema(v) as Json]));
    } else if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) {
      out[key] = value.map((v) => sanitizeSchema(v) as Json);
    } else if (SCHEMA_SINGLE.includes(key)) {
      out[key] = sanitizeSchema(value) as Json;
    } else if (key !== "enum" && key !== "const") {
      out[key] = value;
    }
  }

  const values: Json[] | undefined = Array.isArray(schema.enum)
    ? schema.enum
    : "const" in schema ? [schema.const] : undefined;
  if (values !== undefined) {
    if (values.length > 0 && values.every((v) => typeof v === "string")) {
      out.enum = values;
      if (out.type === undefined) out.type = "string";
    } else if (out.type === undefined && values.length > 0) {
      const inferred = typeOfValue(values[0]);
      if (inferred) out.type = inferred;
    }
  }
  return out;
}
