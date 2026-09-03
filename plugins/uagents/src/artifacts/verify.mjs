import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function verifyCapturedArtifacts(taskDirectory, manifest) {
  const artifacts = manifest.artifacts.map(artifact => {
    if (!artifact.verified || !artifact.captured_path) return artifact;
    try {
      const file = path.join(taskDirectory, ...artifact.captured_path.split('/'));
      const data = fs.readFileSync(file);
      const sha256 = createHash('sha256').update(data).digest('hex');
      return sha256 === artifact.sha256 && data.length === artifact.size_bytes ? artifact : { ...artifact, verified: false, error: 'captured_artifact_changed' };
    } catch (error) { return { ...artifact, verified: false, error: error.code === 'ENOENT' ? 'captured_artifact_missing' : 'captured_artifact_unreadable' }; }
  });
  return { ...manifest, verified: artifacts.every(artifact => artifact.required === false || artifact.verified), artifacts };
}
