import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../protocol/errors.mjs';
import { createRegistry } from './registry.mjs';

export function loadRegistry({ configPath = null, env = process.env } = {}) {
  const selected = configPath ?? env.UAGENTS_CONFIG;
  if (!selected) return createRegistry();
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) {
    fail('invalid_request', 'uAgents config path must be absolute.');
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(selected, 'utf8')); }
  catch { fail('invalid_request', 'uAgents config file must exist and contain valid JSON.'); }
  return createRegistry(config);
}
