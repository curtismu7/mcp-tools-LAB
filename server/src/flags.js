// Flags: the operator marks a tool, resource or prompt of a connection with a note ("this description asks for a
// transfer", "rename this"), to export later as a Markdown review brief. One flag per item; saving again replaces the
// note. Stored like saved inputs (flags.json, mode 600; memory only when the store is virtual).
import crypto from 'node:crypto';
import { createListFile } from './inputs.js';

export const FLAG_LIMITS = { perConnection: 200, nameChars: 500, noteChars: 2000 };
const KINDS = new Set(['tool', 'resource', 'prompt']);
export class FlagError extends Error {}

export function createFlagStore({ dir = null, connectionExists = () => true } = {}) {
  const { load, save, file } = createListFile({ dir, name: 'flags.json', connectionExists });
  return {
    list: (connectionId) => load().filter((x) => x.connectionId === connectionId),
    // Create or replace the flag on (kind, name).
    put(connectionId, { kind, name, note } = {}) {
      if (!KINDS.has(kind)) throw new FlagError('kind must be tool, resource or prompt');
      if (typeof name !== 'string' || !name || name.length > FLAG_LIMITS.nameChars) throw new FlagError(`name is required, at most ${FLAG_LIMITS.nameChars} characters`);
      const text = String(note ?? '').trim();
      if (text.length > FLAG_LIMITS.noteChars) throw new FlagError(`note is at most ${FLAG_LIMITS.noteChars} characters`);
      const all = load();
      const old = all.find((x) => x.connectionId === connectionId && x.kind === kind && x.name === name);
      if (!old && all.filter((x) => x.connectionId === connectionId).length >= FLAG_LIMITS.perConnection) throw new FlagError(`at most ${FLAG_LIMITS.perConnection} flags per connection`);
      const rec = { id: old?.id || crypto.randomUUID(), connectionId, kind, name, note: text, flaggedAt: new Date().toISOString() };
      save([...all.filter((x) => x !== old), rec]);
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
