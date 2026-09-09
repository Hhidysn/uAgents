import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../protocol/errors.mjs';

export function canonicalWorkspace(workspace) {
  if (!path.isAbsolute(workspace ?? '')) fail('invalid_workspace', 'workspace must be absolute.');
  const resolved = path.resolve(workspace);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) fail('invalid_workspace', 'workspace must be an existing directory.');
  const real = fs.realpathSync.native(resolved);
  return process.platform === 'win32' ? real.normalize('NFC').toLocaleLowerCase('en-US') : real.normalize('NFC');
}

export function workspacesOverlap(left, right) {
  const a = canonicalWorkspace(left);
  const b = canonicalWorkspace(right);
  return within(a, b) || within(b, a);
}

export function canonicalWorkspacesOverlap(leftCanonical, rightCanonical) {
  return within(leftCanonical, rightCanonical) || within(rightCanonical, leftCanonical);
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
