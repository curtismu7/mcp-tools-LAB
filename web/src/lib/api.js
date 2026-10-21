// Same-origin fetch wrapper. The browser adds the Origin header the server checks on every write.
export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* 204 or no JSON */ }
  return { ok: res.ok, status: res.status, data };
}
export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const del = (p) => api('DELETE', p);
export const pretty = (v) => JSON.stringify(v, null, 2);
