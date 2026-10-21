import os from 'node:os';
import path from 'node:path';
import { mockOnly } from './mock.js';

export const DEFAULT_PORT = 4810;

export function dataDir(env = process.env) { return env.DATA_DIR || path.join(os.homedir(), '.mcp-tools'); }
export function port(env = process.env) { return Number(env.PORT) || DEFAULT_PORT; }
export function scanMaxBytes(env = process.env) { return Number(env.MCPTOOLS_SCAN_MAX_BYTES) || 1_048_576; }
export function pingoneEnabled(env = process.env) { return env.MCPTOOLS_PINGONE === '1' && !mockOnly(env); }
