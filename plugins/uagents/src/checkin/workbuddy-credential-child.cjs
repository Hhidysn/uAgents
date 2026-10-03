// Runs only in the installed WorkBuddy executable's Node mode. Keying material
// stays in this child; stdout is an internal pipe, never a user-facing log.
const fs = require('node:fs');
const { createHash, createDecipheriv } = require('node:crypto');

try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).auth.accessToken;
  if (value?.$wbEncrypted !== 1 || value.scheme !== undefined) throw new Error();
  const envelope = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  const material = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  if (material.version !== 1 || typeof material.atRestSecretKey !== 'string') throw new Error();
  const key = createHash('sha256').update(material.atRestSecretKey, 'utf8').digest();
  try {
    const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
    if (envelope.suite !== 1 || envelope.keyId !== keyId) throw new Error();
    const prefix = text => {
      const bytes = Buffer.from(text, 'utf8'), length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]);
    };
    const suite = Buffer.alloc(4); suite.writeUInt32BE(1);
    const aad = Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
      prefix('WBEV1'), prefix('sym-v1'), suite, prefix(keyId), Buffer.from([2, 0, 0])]);
    const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.authTag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad); cipher.setAuthTag(tag);
    const token = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]);
    try { process.stdout.write(JSON.stringify({ value: token.toString('utf8') })); }
    finally { token.fill(0); }
  } finally { key.fill(0); }
} catch { process.exitCode = 1; }
