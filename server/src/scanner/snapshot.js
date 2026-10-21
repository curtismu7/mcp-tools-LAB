// Normalise what an operator pastes or loads into { tools, resources, prompts, card }.
// Accepts: a tools array; a tools/list result ({tools}); a JSON-RPC reply ({result:{tools}}); an object with any of
// tools/resources/prompts; an A2A Agent Card (an object with skills and no tools).
export class SnapshotError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function parseSnapshot(input, { maxBytes = 1_048_576 } = {}) {
  let v = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > maxBytes) throw new SnapshotError('too_large', `snapshot is larger than ${maxBytes} bytes`, 413);
    try { v = JSON.parse(input); } catch { throw new SnapshotError('bad_json', 'snapshot is not valid JSON'); }
  }
  if (Array.isArray(v)) return { tools: v };
  if (!v || typeof v !== 'object') throw new SnapshotError('bad_snapshot', 'snapshot must be a JSON object or array');
  const body = v.result && typeof v.result === 'object' ? v.result : v;
  const out = {};
  for (const k of ['tools', 'resources', 'prompts']) if (Array.isArray(body[k])) out[k] = body[k];
  if (!out.tools && Array.isArray(body.skills)) out.card = body;
  if (!out.tools && !out.resources && !out.prompts && !out.card) throw new SnapshotError('bad_snapshot', 'no tools, resources, prompts or agent card found; paste a tools/list result or a JSON array of tools');
  return out;
}
