import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from '../protocol/errors.mjs';
import { pathIsWithin } from '../path-containment.mjs';
import { canonicalWorkspace } from '../runtime/workspace-key.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({
  file_bytes: 32 * 1024 * 1024,
  image_bytes: 20 * 1024 * 1024,
  total_bytes: 64 * 1024 * 1024,
  image_dimension_px: 16_384,
  image_pixels: 64 * 1024 * 1024,
});

export function readWorkspaceAttachment(workspace, input) {
  const root = canonicalWorkspace(workspace);
  const candidate = path.resolve(workspace, input.path);
  let real;
  try { real = fs.realpathSync.native(candidate); }
  catch (error) { fail('invalid_input', `Input cannot be read: ${input.path}`, { details: { cause: error.code } }); }
  const normalized = process.platform === 'win32' ? real.normalize('NFC').toLocaleLowerCase('en-US') : real.normalize('NFC');
  if (!pathIsWithin(root, normalized)) fail('invalid_input', `Input resolves outside workspace: ${input.path}`);
  return readAttachmentFile(real, input.type, input.path, input.path);
}

export function ingestAttachmentSources(workspace, inputs) {
  if (!inputs.some(input => input.source !== undefined)) return inputs;
  canonicalWorkspace(workspace);
  return inputs.map(input => {
    if (input.source === undefined) return input;
    let real;
    try { real = fs.realpathSync.native(input.source); }
    catch (error) { fail('invalid_input', `Attachment source cannot be read: ${input.source}`, { details: { cause: error.code } }); }
    const attachment = readAttachmentFile(real, input.type, input.source, null);
    const name = portableAttachmentName(real);
    const relative = `.uagents/inputs/${attachment.sha256}-${name}`;
    const destination = path.resolve(workspace, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, attachment.bytes);
    return { type: input.type, path: relative };
  });
}

function readAttachmentFile(real, type, label, relativePath = null) {
  const info = fs.statSync(real);
  if (!info.isFile()) fail('invalid_input', `Input is not a file: ${label}`);
  const maximum = type === 'image' ? ATTACHMENT_LIMITS.image_bytes : ATTACHMENT_LIMITS.file_bytes;
  if (info.size > maximum) fail('invalid_input', `Input exceeds ${maximum} bytes: ${label}`);
  const bytes = fs.readFileSync(real);
  const media = type === 'image' ? inspectImage(bytes, label) : inspectFile(bytes);
  return {
    type,
    ...(relativePath === null ? {} : { path: relativePath }),
    media_type: media.media_type,
    size_bytes: info.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(media.width_px ? { width_px: media.width_px, height_px: media.height_px } : {}),
    bytes,
    absolute_path: real,
  };
}

function portableAttachmentName(source) {
  const cleaned = path.basename(source).normalize('NFC').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'attachment';
}

export function attachmentSnapshot(workspace, input) {
  const { bytes, absolute_path, ...snapshot } = readWorkspaceAttachment(workspace, input);
  return snapshot;
}

export function snapshotMatches(current, persisted) {
  if (!current || !persisted || current.type !== persisted.type || current.path !== persisted.path) return false;
  return Object.keys(persisted).every(key => current[key] === persisted[key]);
}

function inspectFile(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return { media_type: 'application/pdf' };
  return { media_type: 'application/octet-stream' };
}

function inspectImage(bytes, inputPath) {
  let media;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString('ascii') === 'IHDR') {
    media = { media_type: 'image/png', width_px: bytes.readUInt32BE(16), height_px: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 10 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    media = { media_type: 'image/gif', width_px: bytes.readUInt16LE(6), height_px: bytes.readUInt16LE(8) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    media = { media_type: 'image/jpeg', ...jpegDimensions(bytes, inputPath) };
  } else if (bytes.length >= 30 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    media = { media_type: 'image/webp', ...webpDimensions(bytes, inputPath) };
  } else {
    fail('invalid_input', `Unsupported or unrecognized image format: ${inputPath}`);
  }
  validateImageDimensions(media, inputPath);
  return media;
}

function validateImageDimensions(media, inputPath) {
  const { width_px: width, height_px: height } = media;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    fail('invalid_input', `Image dimensions are invalid: ${inputPath}`);
  }
  if (width > ATTACHMENT_LIMITS.image_dimension_px || height > ATTACHMENT_LIMITS.image_dimension_px || width * height > ATTACHMENT_LIMITS.image_pixels) {
    fail('invalid_input', `Image dimensions exceed the attachment contract: ${inputPath}`);
  }
}

function jpegDimensions(bytes, inputPath) {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) break;
      return { height_px: bytes.readUInt16BE(offset + 3), width_px: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  fail('invalid_input', `JPEG dimensions cannot be verified: ${inputPath}`);
}

function isJpegStartOfFrame(marker) {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function webpDimensions(bytes, inputPath) {
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width_px: 1 + readUInt24LE(bytes, 24), height_px: 1 + readUInt24LE(bytes, 27) };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
    return {
      width_px: 1 + (((b2 & 0x3f) << 8) | b1),
      height_px: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width_px: bytes.readUInt16LE(26) & 0x3fff, height_px: bytes.readUInt16LE(28) & 0x3fff };
  }
  fail('invalid_input', `WebP dimensions cannot be verified: ${inputPath}`);
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
