// Estimated token cost: characters / 4, rounded up. The same rule as server/src/proxy/tokens.js. A rough heuristic for
// English text and JSON, not a tokenizer; every place that shows it says "~" and "estimate".
export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ? Math.ceil(text.length / 4) : 0;
}
export const TOKEN_NOTE = "estimate: characters / 4, not a tokenizer";
