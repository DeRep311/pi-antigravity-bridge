// Model catalog exposed to Pi and mapping from Pi reasoning levels to agy model variants.
// agy encodes effort in the model id (e.g. gemini-4-argon-high), so Pi selects a base family
// and the bridge picks the variant from the subagent's effort / thinking level.

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CONTEXT_WINDOW = 1048576;

const FAMILIES: { id: string; name: string; maxTokens: number }[] = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon (agy)", maxTokens: 65536 },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen (agy)", maxTokens: 65536 },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (agy)", maxTokens: 65536 },
];

export const MODELS = FAMILIES.map((f) => ({
  id: f.id,
  name: f.name,
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { ...ZERO_COST },
  contextWindow: CONTEXT_WINDOW,
  maxTokens: f.maxTokens,
}));

const LEVELS = ["low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

function levelFor(reasoning: string | undefined): Level {
  switch (reasoning) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
    default:
      return "medium";
  }
}

/**
 * Resolve the agy model id for a Pi model id and reasoning level.
 * Explicit variant ids and unknown models pass through unchanged; a missing level falls back
 * to the nearest lower available one.
 */
export function resolveVariant(modelId: string, reasoning: string | undefined, available: string[]): string {
  if (available.includes(modelId) || !available.some((id) => id.startsWith(`${modelId}-`))) return modelId;
  const wanted = LEVELS.indexOf(levelFor(reasoning));
  for (let i = wanted; i >= 0; i--) {
    const candidate = `${modelId}-${LEVELS[i]}`;
    if (available.includes(candidate)) return candidate;
  }
  return available.find((id) => id.startsWith(`${modelId}-`)) ?? modelId;
}
