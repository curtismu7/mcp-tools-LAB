// Estimated token cost of a JSON value or a string: characters / 4, rounded up. This is a rough heuristic for English
// text and JSON, not a tokenizer: real counts differ by model. Every screen that shows a number says "~" and "estimate".
export const TOKEN_METHOD = 'estimate: characters / 4 (not a tokenizer; real counts differ by model)';

export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text ? Math.ceil(text.length / 4) : 0;
}
