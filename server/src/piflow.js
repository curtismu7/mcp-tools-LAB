// PingOne sign-in by pi.flow (rule 16: Ping logins are pi.flow only, never a browser redirect). Copied and trimmed from
// pingone-LAB server/src/piflow.js (same author, MIT; copied, never imported across repos): cookie jar, flow statuses,
// user.lookup + usernamePassword.check, resume for the code. Changes: no trace, PAR or JAR; one engine for any
// PingOne issuer the caller trusts; `resource` (RFC 8707) is sent with the authorization and token requests.
//
// The authorization request carries response_mode=pi.flow, so PingOne answers with a JSON flow instead of a login page.
// This server posts the username and password to <issuer-base>/flows/{id}, then asks <issuer-base>/as/resume for the
// code and redeems it with PKCE. The browser only ever talks to this tool: the flow id (a bearer handle), the password
// and the tokens never reach it. The password is used once and never kept or logged.
import crypto from 'node:crypto';

export const USER_LOOKUP = 'application/vnd.pingidentity.user.lookup+json';
export const USERNAME_PASSWORD_CHECK = 'application/vnd.pingidentity.usernamePassword.check+json';
export const CREDENTIAL_STATUSES = new Set(['USERNAME_PASSWORD_REQUIRED', 'SIGN_ON_REQUIRED', 'PASSWORD_REQUIRED']);
const FLOW_ID = /^[A-Za-z0-9_-]{6,128}$/;
const RUN_TTL_MS = 5 * 60 * 1000;
const MAX_STEPS = 6;
const MAX_COOKIES = 30;
const TIMEOUT_MS = 15_000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export class PiFlowError extends Error { constructor(message, code = 'piflow_error', status = 400) { super(message); this.code = code; this.status = status; } }

export function mergeCookies(jar, setCookies) {
  const next = { ...jar };
  for (const line of setCookies || []) {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || value.length > 4096 || CONTROL.test(value)) continue;
    if (!Object.hasOwn(next, name) && Object.keys(next).length >= MAX_COOKIES) continue;
    next[name] = value;
  }
  return next;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function call(url, { method = 'GET', headers = {}, body, jar }) {
  let res;
  try {
    res = await fetch(url, { method, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', ...headers, ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) } });
  } catch (err) { throw new PiFlowError(`PingOne unreachable (${err?.cause?.code || err?.name || 'network error'})`, 'piflow_unreachable', 502); }
  const text = (await res.text()).slice(0, 64 * 1024);
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json, location: res.headers.get('location'), setCookies: res.headers.getSetCookie?.() || [] };
}

/**
 * meta: { issuer, authorizationEndpoint, tokenEndpoint }  (from discovery; the flows and resume URLs sit beside /as)
 * onTokens(key, tokens) is called once a run is accepted; the engine keeps no token itself.
 */
export function createPiFlow({ now = Date.now } = {}) {
  const runs = new Map(); // run handle (random, given to the browser) -> run (flow id, verifier, cookies: server side only)

  const authBase = (issuer) => String(issuer).replace(/\/as\/?$/, '');
  const sweep = () => { for (const [k, r] of runs) if (r.expiresAt <= now()) runs.delete(k); };

  function view(handle, run, extra = {}) {
    return { run: handle, status: run.status, state: CREDENTIAL_STATUSES.has(run.status) ? 'credentials_required' : 'stopped', expiresAt: new Date(run.expiresAt).toISOString(), ...extra };
  }

  // A new run is free, so without a limit a script on the page could try passwords as fast as it can start runs.
  // At most 5 starts per target per minute; PingOne's own lockout is the second line.
  const starts = new Map();
  async function start({ key, meta, clientId, redirectUri, resource, scope, onTokens }) {
    sweep();
    const recent = (starts.get(key) || []).filter((t) => now() - t < 60_000);
    if (recent.length >= 5) throw new PiFlowError('too many sign-in attempts; wait a minute and try again', 'piflow_rate_limited', 429);
    starts.set(key, [...recent, now()]);
    for (const [k, r] of runs) if (r.key === key) runs.delete(k); // one sign-in per target at a time
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(24));
    const url = new URL(meta.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scope || 'openid', state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      response_mode: 'pi.flow', ...(resource ? { resource } : {}),
    }).toString();
    const r = await call(url.toString(), {});
    const jar = mergeCookies({}, r.setCookies);
    if (!r.ok || !FLOW_ID.test(String(r.json?.id || ''))) {
      const why = r.json?.error || r.json?.code || `HTTP ${r.status}`;
      throw new PiFlowError(`PingOne did not open a pi.flow sign-in (${String(why).slice(0, 60)}). The application needs the pi.flow response mode allowed.`, 'piflow_not_opened', 502);
    }
    const handle = b64url(crypto.randomBytes(24));
    const run = { key, meta, clientId, redirectUri, resource, verifier, state, jar, flowId: r.json.id, status: r.json.status, steps: 1, expiresAt: now() + RUN_TTL_MS, onTokens };
    runs.set(handle, run);
    if (run.status === 'COMPLETED') return complete(handle, run); // an existing PingOne session (SSO)
    return view(handle, run);
  }

  async function post(run, contentType, payload) {
    const r = await call(`${authBase(run.meta.issuer)}/flows/${run.flowId}`, { method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(payload), jar: run.jar });
    run.jar = mergeCookies(run.jar, r.setCookies);
    return r;
  }

  // `key` must be the target the run was started for: a handle from one connection cannot finish another's sign-in.
  async function credentials(handle, { username, password } = {}, key) {
    const found = typeof handle === 'string' ? runs.get(handle) : null;
    const run = found && found.key === key ? found : null;
    if (!run || run.expiresAt <= now()) { if (run) runs.delete(handle); throw new PiFlowError('this sign-in expired or is unknown; start again', 'piflow_no_run', 409); }
    if (!CREDENTIAL_STATUSES.has(run.status)) throw new PiFlowError(`the sign-in is at ${run.status}, not waiting for a password`, 'piflow_wrong_status', 409);
    if (typeof username !== 'string' || !username || username.length > 256 || CONTROL.test(username)) throw new PiFlowError('username must be 1 to 256 characters', 'piflow_bad_username');
    if (typeof password !== 'string' || !password || password.length > 1024) throw new PiFlowError('password must be 1 to 1024 characters', 'piflow_bad_password');
    if (++run.steps > MAX_STEPS) { runs.delete(handle); throw new PiFlowError('too many sign-in steps; start again', 'piflow_too_many_steps', 409); }
    if (run.status === 'SIGN_ON_REQUIRED') { // identifier first: the username alone, then the password
      const lookup = await post(run, USER_LOOKUP, { username });
      if (lookup.status === 404 || lookup.status === 410) { runs.delete(handle); throw new PiFlowError('PingOne no longer knows this sign-in; start again', 'piflow_gone', 409); }
      if (!lookup.ok || !lookup.json?.status) { runs.delete(handle); throw new PiFlowError(`PingOne refused the username step (${String(lookup.json?.code || lookup.status).slice(0, 40)})`, 'piflow_refused', 502); }
      run.status = lookup.json.status;
      if (!CREDENTIAL_STATUSES.has(run.status) && run.status !== 'COMPLETED') return view(handle, run);
    }
    const r = await post(run, USERNAME_PASSWORD_CHECK, { username, password });
    if (!r.ok) {
      if (r.status === 400 && Array.isArray(r.json?.details) && r.json.details.some((d) => d?.code === 'INVALID_CREDENTIALS')) return view(handle, run, { refused: 'The username or password is not right.' });
      runs.delete(handle);
      if (r.status === 404 || r.status === 410) throw new PiFlowError('PingOne no longer knows this sign-in; start again', 'piflow_gone', 409);
      throw new PiFlowError(`PingOne refused the sign-in (${String(r.json?.code || r.status).slice(0, 40)})`, 'piflow_refused', 502);
    }
    run.status = r.json?.status || 'UNKNOWN';
    if (run.status === 'COMPLETED') return complete(handle, run);
    return view(handle, run); // MFA, consent or another step this tool does not drive: the panel names the status
  }

  async function complete(handle, run) {
    runs.delete(handle);
    const r = await call(`${authBase(run.meta.issuer)}/as/resume?flowId=${encodeURIComponent(run.flowId)}`, { jar: run.jar });
    let answer = r.json?.authorizeResponse || null;
    if (!answer && r.location) {
      try { const loc = new URL(r.location, run.meta.issuer); answer = Object.fromEntries(['code', 'state', 'error'].filter((k) => loc.searchParams.has(k)).map((k) => [k, loc.searchParams.get(k)])); } catch { answer = null; }
    }
    if (!answer) throw new PiFlowError('PingOne finished the sign-in but returned no code', 'piflow_no_code', 502);
    if (answer.state !== run.state) throw new PiFlowError('the sign-in came back with a different state', 'piflow_state_mismatch', 502);
    if (answer.error) throw new PiFlowError(`PingOne refused: ${String(answer.error).slice(0, 60)}`, 'piflow_refused', 502);
    if (typeof answer.code !== 'string' || !answer.code) throw new PiFlowError('PingOne returned no code', 'piflow_no_code', 502);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: answer.code, redirect_uri: run.redirectUri, client_id: run.clientId, code_verifier: run.verifier, ...(run.resource ? { resource: run.resource } : {}) });
    const t = await call(run.meta.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!t.ok || typeof t.json?.access_token !== 'string') throw new PiFlowError(`the token request failed (${String(t.json?.error || t.status).slice(0, 40)})`, 'piflow_token_failed', 502);
    run.onTokens(run.key, t.json);
    return { run: null, status: 'COMPLETED', state: 'signed_in' };
  }

  return { start, credentials, clear: () => runs.clear() };
}
