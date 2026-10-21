// Request guards for a tool that connects to servers the operator names.
//  1. Bind loopback only, unless MCPTOOLS_BIND is set (an explicit opt-in).
//  2. Reject any request whose Host header is not a loopback name (DNS-rebinding guard), unless the operator listed it
//     in MCPTOOLS_ALLOWED_HOSTS (or it is the MCPTOOLS_BIND address).
//  3. Every state-changing API call (anything but GET/HEAD) must carry an Origin whose host is exactly the Host header.
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

export function hostCheck(env = process.env) {
  const allowed = new Set(allowedHostNames(env));
  return (req, res, next) => {
    const name = hostName(req.headers.host);
    if (name && (isLoopbackHost(name) || allowed.has(name))) return next();
    return res.status(403).json({ error: 'bad_host', message: 'This tool answers only to a loopback Host header. Set MCPTOOLS_ALLOWED_HOSTS to allow another.' });
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function sameOriginWrites() {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const origin = req.headers.origin;
    let ok = false;
    try { ok = Boolean(origin) && new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'State-changing calls must come from this tool\'s own page (Origin must match Host).' });
    return next();
  };
}
