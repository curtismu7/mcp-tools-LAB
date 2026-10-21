// Secrets (tokens, stdio env values) must never reach a response, a log line or a trace. Any message that might echo
// one goes through scrub() first.
export function scrub(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) s = s.split(secret).join('[redacted]');
  }
  return s;
}

// A server-supplied string shown to the operator: capped, never trusted as markup (the UI renders text nodes only).
export const clip = (v, n = 300) => String(v ?? '').slice(0, n);

// Same for a JSON value that came from a server (a tool result, a listing): any secret this tool sent it that comes
// back in the reply is replaced before the value reaches the browser.
export function scrubJson(value, secrets = []) {
  const live = secrets.filter((x) => typeof x === 'string' && x.length >= 4);
  if (!live.length) return value;
  let text = JSON.stringify(value);
  if (text === undefined) return value;
  for (const secret of live) text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
  return JSON.parse(text);
}
