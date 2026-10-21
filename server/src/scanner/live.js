// Collect what a live MCP server offers, for scanning. Read-only: tools/list, resources/list, prompts/list, and (when
// asked) resources/read and prompts/get so the content a model would be handed can be judged too. It never calls
// tools/call. `client` is anything with rpc(method, params) and info() (see mcp/http.js, mcp/stdio.js).
const MAX_PAGES = 10;
const MAX_ITEMS = 1000;
const MAX_FETCH = 25;

async function listAll(client, method, key) {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES && items.length < MAX_ITEMS; page++) {
    const r = await client.rpc(method, cursor ? { cursor } : {});
    items.push(...(Array.isArray(r?.[key]) ? r[key] : []));
    cursor = r?.nextCursor;
    if (!cursor) return { items: items.slice(0, MAX_ITEMS), more: false };
  }
  return { items: items.slice(0, MAX_ITEMS), more: true };
}

export async function collectFromClient(client, { fetchContent = true } = {}) {
  await client.ensure?.();
  const caps = client.info?.()?.capabilities || {};
  const notes = [];
  const out = { tools: [], resources: [], prompts: [], notes };

  const tools = await listAll(client, 'tools/list', 'tools');
  out.tools = tools.items;
  if (tools.more) notes.push('tools/list had more pages than the scan reads');

  if (caps.resources) {
    try {
      const r = await listAll(client, 'resources/list', 'resources');
      out.resources = r.items;
      if (fetchContent) {
        for (const res of out.resources.slice(0, MAX_FETCH)) {
          if (typeof res?.uri !== 'string') continue;
          try { res.contents = (await client.rpc('resources/read', { uri: res.uri }))?.contents || []; }
          catch (e) { notes.push(`resources/read ${String(res.uri).slice(0, 80)} failed: ${e.message}`); }
        }
        if (out.resources.length > MAX_FETCH) notes.push(`only the first ${MAX_FETCH} resources were read`);
      }
    } catch (e) { notes.push(`resources/list failed: ${e.message}`); }
  }
  if (caps.prompts) {
    try {
      const r = await listAll(client, 'prompts/list', 'prompts');
      out.prompts = r.items;
      if (fetchContent) {
        for (const p of out.prompts.slice(0, MAX_FETCH)) {
          if (typeof p?.name !== 'string') continue;
          const args = Object.fromEntries((Array.isArray(p.arguments) ? p.arguments : []).map((a) => [String(a?.name), 'demo-value']));
          try { p.messages = (await client.rpc('prompts/get', { name: p.name, arguments: args }))?.messages || []; }
          catch (e) { notes.push(`prompts/get ${String(p.name).slice(0, 80)} failed: ${e.message}`); }
        }
        if (out.prompts.length > MAX_FETCH) notes.push(`only the first ${MAX_FETCH} prompts were read`);
      }
    } catch (e) { notes.push(`prompts/list failed: ${e.message}`); }
  }
  return out;
}
