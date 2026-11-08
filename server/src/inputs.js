// Saved inputs: named argument sets per connection and tool, so a call can be re-run without retyping it. Loading one
// only fills the call form: the Review + confirm gate still applies to every call.
//  - Disk store: `inputs.json` next to `connections.json`, mode 600 in the mode 700 data dir (arguments can hold
//    anything the operator typed). Entries whose connection no longer exists are dropped on every write.
//  - Memory store (mock-only, or tests): nothing touches disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INPUT_LIMITS = { perConnection: 50, nameChars: 80, argBytes: 64 * 1024 };
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
export class InputError extends Error {}

// A JSON array file of per-connection records (mode 600 in a mode 700 dir), or memory when dir is null. Records whose
// connection no longer exists are dropped on every write. Shared by saved inputs and flags.
export function createListFile({ dir = null, name, connectionExists = () => true }) {
  const file = dir ? path.join(dir, name) : null;
  let memory = [];
  function load() {
    if (!file) return memory;
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter((x) => isObject(x) && typeof x.id === 'string') : []; } catch { return []; }
  }
  function save(all) {
    const kept = all.filter((x) => connectionExists(x.connectionId));
    if (!file) { memory = kept; return; }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }
  return { load, save, file };
}

export function createInputStore({ dir = null, connectionExists = () => true } = {}) {
  const { load, save, file } = createListFile({ dir, name: 'inputs.json', connectionExists });

  return {
    list: (connectionId, tool) => load().filter((x) => x.connectionId === connectionId && (tool === undefined || x.tool === tool)),
    create(connectionId, { tool, name, arguments: args, source } = {}) {
      if (typeof tool !== 'string' || !tool || tool.length > 200) throw new InputError('tool must be a tool name');
      const label = String(name ?? '').trim();
      if (!label || label.length > INPUT_LIMITS.nameChars) throw new InputError(`name is required, at most ${INPUT_LIMITS.nameChars} characters`);
      if (!isObject(args)) throw new InputError('arguments must be a JSON object');
      if (Buffer.byteLength(JSON.stringify(args)) > INPUT_LIMITS.argBytes) throw new InputError(`arguments are larger than ${INPUT_LIMITS.argBytes / 1024} KB`);
      const all = load();
      if (all.filter((x) => x.connectionId === connectionId).length >= INPUT_LIMITS.perConnection) throw new InputError(`at most ${INPUT_LIMITS.perConnection} saved inputs per connection; delete one first`);
      const rec = { id: crypto.randomUUID(), connectionId, tool, name: label, arguments: args, source: source === 'flow' ? 'flow' : 'manual', createdAt: new Date().toISOString() };
      save([...all, rec]);
      return rec;
    },
    remove(connectionId, id) {
      const all = load();
      const next = all.filter((x) => !(x.connectionId === connectionId && x.id === id));
      if (next.length === all.length) return false;
      save(next); return true;
    },
    removeFor(connectionId) { save(load().filter((x) => x.connectionId !== connectionId)); },
    clear() { save([]); },
    file,
  };
}
