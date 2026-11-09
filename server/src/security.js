// Request guards for a tool that connects to servers the operator names.
//  1. Bind loopback only, unless MCPTOOLS_BIND is set (an explicit opt-in).
//  2. Reject any request whose Host header is not a loopback name (DNS-rebinding guard), unless the operator listed it
//     in MCPTOOLS_ALLOWED_HOSTS (or it is the MCPTOOLS_BIND address), or it is "<LAB_ALLOWED_HOSTS name>:<PORT>" (the
//     family lab-proxy's name for this tool).
//  3. Every state-changing API call (anything but GET/HEAD) must carry an Origin whose host is exactly the Host header,
//     or, on a LAB_ALLOWED_HOSTS Host only, an Origin equal to X-Forwarded-Proto://X-Forwarded-Host (the lab-proxy's).
// Loopback helper adapted from hostile-mcp server/src/safety.js (MIT, same author).

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.MCPTOOLS_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.MCPTOOLS_BIND) return host;
  throw new Error(`refusing to bind ${host}: this tool connects to servers you name and listens on loopback only. Set MCPTOOLS_BIND to opt in.`);
}

// "host:port" or "[::1]:port" or "host" -> bare host name.
function hostName(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

export function allowedHostNames(env = process.env) {
  const extra = String(env.MCPTOOLS_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (env.MCPTOOLS_BIND && env.MCPTOOLS_BIND !== '0.0.0.0' && env.MCPTOOLS_BIND !== '::') extra.push(env.MCPTOOLS_BIND.toLowerCase());
  return extra;
}

// LAB_ALLOWED_HOSTS: comma list of host names (no ports), each accepted in Host only as "<name>:<PORT>". Unset = none.
export function labProxyHosts(env = process.env) {
  const names = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(n)) throw new Error(`LAB_ALLOWED_HOSTS: "${n}" is not a host name`);
  const port = Number(env.PORT) || 4810;
  return new Set(names.map((n) => `${n}:${port}`));
}

// Behind the family lab-proxy the browser's Origin is the launcher's while Host is this tool's LAB_ALLOWED_HOSTS name.
// X-Forwarded-Host/-Proto are believed only on such a Host, so a request that did not come through the proxy cannot use them.
export function isProxiedSameOrigin(headers, proxyHosts) {
  const xfh = String(headers['x-forwarded-host'] || '').trim().toLowerCase();
  const xfp = String(headers['x-forwarded-proto'] || '').trim().toLowerCase();
  return proxyHosts.has(String(headers.host || '').trim().toLowerCase()) && xfh !== '' && (xfp === 'https' || xfp === 'http')
    && headers.origin === `${xfp}://${xfh}`;
}

export function hostCheck(env = process.env, proxyHosts = labProxyHosts(env)) {
  const allowed = new Set(allowedHostNames(env));
  return (req, res, next) => {
    const name = hostName(req.headers.host);
    if (name && (isLoopbackHost(name) || allowed.has(name) || proxyHosts.has(String(req.headers.host).trim().toLowerCase()))) return next();
    return res.status(403).json({ error: 'bad_host', message: 'This tool answers only to a loopback Host header. Set MCPTOOLS_ALLOWED_HOSTS to allow another.' });
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function sameOriginWrites(proxyHosts = new Set()) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const origin = req.headers.origin;
    let ok = isProxiedSameOrigin(req.headers, proxyHosts);
    if (!ok) try { ok = Boolean(origin) && new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'State-changing calls must come from this tool\'s own page (Origin must match Host).' });
    return next();
  };
}
