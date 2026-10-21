import crypto from 'node:crypto';

// Stable JSON: object keys sorted at every depth. Used for the confirm hash, so "the exact arguments the user was
// shown" has one byte-for-byte form.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// The confirm contract: argsHash = sha256(connectionId \n method \n name \n canonicalJson(arguments)).
export function argsHash({ connectionId, method, name = '', args }) {
  return crypto.createHash('sha256').update(`${connectionId}\n${method}\n${name}\n${canonicalJson(args ?? {})}`).digest('hex');
}
