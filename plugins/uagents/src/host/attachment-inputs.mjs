import fs from 'node:fs';
import path from 'node:path';
import { ATTACHMENT_LIMITS } from '../artifacts/attachments.mjs';
import { fail } from '../protocol/errors.mjs';
import { REQUEST_LIMITS } from '../protocol/schema.mjs';

const HOST_ATTACHMENT_FIELDS = new Set(['type', 'local_path', 'name']);

export function hostAttachmentsToInputs(attachments) {
  if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > REQUEST_LIMITS.inputs) {
    fail('invalid_request', `attachments must contain 1-${REQUEST_LIMITS.inputs} entries.`);
  }
  let totalBytes = 0;
  return attachments.map((attachment, index) => {
    if (!attachment || Array.isArray(attachment) || typeof attachment !== 'object' || Object.getPrototypeOf(attachment) !== Object.prototype) {
      fail('invalid_input', `attachments[${index}] must be a plain object.`);
    }
    for (const key of Object.keys(attachment)) {
      if (!HOST_ATTACHMENT_FIELDS.has(key)) fail('unsupported_field', `Unsupported attachments[${index}] field: ${key}`);
    }
    if (attachment.type !== 'file' && attachment.type !== 'image') fail('invalid_input', `attachments[${index}].type must be file or image.`);
    if (typeof attachment.local_path !== 'string' || !attachment.local_path.trim() || !path.isAbsolute(attachment.local_path)) {
      fail('invalid_input', `attachments[${index}].local_path must be an absolute local path.`);
    }

    let real;
    try { real = fs.realpathSync.native(attachment.local_path); }
    catch (error) { fail('invalid_input', `Host attachment cannot be read: ${attachment.local_path}`, { details: { cause: error.code } }); }
    const stat = fs.statSync(real);
    if (!stat.isFile()) fail('invalid_input', `Host attachment is not a file: ${attachment.local_path}`);
    const maximum = attachment.type === 'image' ? ATTACHMENT_LIMITS.image_bytes : ATTACHMENT_LIMITS.file_bytes;
    if (stat.size > maximum) fail('invalid_input', `Host attachment exceeds ${maximum} bytes: ${attachment.local_path}`);
    totalBytes += stat.size;
    if (totalBytes > ATTACHMENT_LIMITS.total_bytes) fail('invalid_input', `Host attachments exceed ${ATTACHMENT_LIMITS.total_bytes} total bytes.`);

    const name = hostAttachmentName(attachment.name ?? path.basename(real), index);
    const bytes = fs.readFileSync(real);
    return {
      type: attachment.type,
      blob: { name, data_base64: bytes.toString('base64') },
    };
  });
}

export function normalizeHostAttachmentRequest(input) {
  if (!input?.attachments) return input;
  if (input.inputs !== undefined) fail('invalid_request', 'Host submit requires exactly one of inputs or attachments.');
  const { attachments, ...request } = input;
  return { ...request, inputs: hostAttachmentsToInputs(attachments) };
}

function hostAttachmentName(value, index) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > REQUEST_LIMITS.attachment_name_bytes) {
    fail('invalid_input', `attachments[${index}].name must be a non-empty filename up to ${REQUEST_LIMITS.attachment_name_bytes} bytes.`);
  }
  const normalized = value.normalize('NFC');
  if (/[\\/\x00-\x1f]/.test(normalized) || normalized === '.' || normalized === '..') {
    fail('invalid_input', `attachments[${index}].name must be a filename, not a path.`);
  }
  return normalized;
}
