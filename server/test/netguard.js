// Shared test netguard (rule 1, zero outbound by default). Blocks and records every socket connect (except to the app's
// own port), DNS lookup/resolve and child process. Used by mock-hardening.test.js and gateway.test.js.
import cp from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';

// Blocks and records every socket connect (except to the app's own port), DNS lookup/resolve and child process.
export function installGuard() {
  const attempts = [];
  let allowed = -1;
  const saved = [];
  const patch = (obj, key, make) => { const orig = obj[key]; if (typeof orig !== 'function') return; saved.push([obj, key, orig]); obj[key] = make(orig); };
  const block = (kind, target) => { attempts.push({ kind, target }); throw new Error(`netguard: blocked ${kind} ${target}`); };
  patch(net.Socket.prototype, 'connect', (orig) => function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = typeof first === 'object' && first ? first : { port: first, host: args[1] };
    if (o.path || Number(o.port) !== allowed || !['127.0.0.1', '::1', 'localhost', undefined].includes(o.host)) block('connect', o.path ? `unix:${o.path}` : `${o.host}:${o.port}`);
    return orig.apply(this, args);
  });
  const loopbackName = (h) => ['127.0.0.1', '::1', 'localhost'].includes(h); // the test client's own fetch to the app
  for (const k of ['lookup', 'lookupService', ...Object.getOwnPropertyNames(dns.Resolver.prototype).filter((n) => /^(resolve|reverse)/.test(n))]) {
    patch(dns, k, (orig) => (...a) => (k === 'lookup' && loopbackName(a[0]) ? orig.apply(dns, a) : block('dns', `${k}(${String(a[0])})`)));
  }
  for (const k of Object.keys(dns.promises)) patch(dns.promises, k, () => async (...a) => block('dns', `promises.${k}(${String(a[0])})`));
  for (const k of ['lookup', 'lookupService', ...Object.getOwnPropertyNames(dns.Resolver.prototype).filter((n) => /^(resolve|reverse)/.test(n))]) patch(dns.Resolver.prototype, k, () => function (...a) { return block('dns', `Resolver.${k}(${String(a[0])})`); });
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(cp, k, () => (...a) => block('process', `${k}(${String(a[0])})`));
  return { attempts, allow(p) { allowed = p; }, uninstall() { for (const [o, k, f] of saved.reverse()) o[k] = f; } };
}

