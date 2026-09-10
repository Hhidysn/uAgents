import fs from 'node:fs';
import path from 'node:path';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { errorRecord, fail } from '../protocol/errors.mjs';
import { buildCouncilMemberRequests, parseCouncilRequest } from '../protocol/council-schema.mjs';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import { uuidPattern } from '../protocol/schema.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ATTENTION = new Set(['waiting_user', 'indeterminate']);

export class CouncilService {
  constructor({ stateRoot, registry, submitTask, statusTask, resultTask, clock = () => Date.now() }) {
    this.stateRoot = stateRoot;
    this.registry = registry;
    this.submitTask = submitTask;
    this.statusTask = statusTask;
    this.resultTask = resultTask;
    this.clock = clock;
  }

  submit(input) {
    const council = parseCouncilRequest(input);
    const memberRequests = buildCouncilMemberRequests(council);
    for (const request of memberRequests) evaluateRequest(request, { registry: this.registry });
    const hash = canonicalHash(council);
    const directory = councilDirectory(this.stateRoot, council.council_id);
    fs.mkdirSync(directory, { recursive: true });
    const requestFile = path.join(directory, 'request.json');
    const manifestFile = path.join(directory, 'manifest.json');
    let manifest = readJsonIfExists(manifestFile);
    const duplicate = Boolean(manifest);
    if (manifest) {
      if (manifest.request_hash !== hash) fail('request_conflict', 'council_id is already registered with different content.', { category: 'conflict', submission: 'not_sent' });
    } else {
      atomicWriteJson(requestFile, council);
      manifest = {
        schema_version: council.schema_version,
        council_id: council.council_id,
        request_hash: hash,
        strategy: council.strategy,
        created_at_ms: this.clock(),
        members: council.members.map(member => ({
          member_id: member.member_id,
          target: member.target,
          model: member.model,
          task_id: member.task_id,
          registration_error: null,
        })),
      };
      atomicWriteJson(manifestFile, manifest);
    }

    for (const [index, request] of memberRequests.entries()) {
      try {
        this.submitTask(request);
        manifest.members[index].registration_error = null;
      } catch (error) {
        manifest.members[index].registration_error = errorRecord(error);
      }
      atomicWriteJson(manifestFile, manifest);
    }
    return { ...this.status(council.council_id), duplicate };
  }

  status(councilId) {
    const manifest = this.#manifest(councilId);
    const members = manifest.members.map(member => {
      let task = null;
      if (!member.registration_error) {
        try { task = this.statusTask(member.task_id); }
        catch (error) { if (error.code !== 'task_not_found') throw error; }
      }
      return { ...member, task };
    });
    return {
      schema_version: manifest.schema_version,
      council_id: manifest.council_id,
      strategy: manifest.strategy,
      status: councilState(members),
      members,
      created_at_ms: manifest.created_at_ms,
    };
  }

  result(councilId) {
    const status = this.status(councilId);
    return {
      ...status,
      members: status.members.map(member => ({
        ...member,
        result: member.task ? this.resultTask(member.task_id) : null,
      })),
    };
  }

  #manifest(councilId) {
    const manifest = readJsonIfExists(path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'));
    if (!manifest) fail('task_not_found', `Unknown council: ${councilId}`);
    return manifest;
  }
}

function councilState(members) {
  if (members.some(member => member.registration_error || member.task === null)) return 'partial';
  if (members.every(member => TERMINAL.has(member.task.status))) return 'complete';
  if (members.some(member => ATTENTION.has(member.task.status))) return 'attention';
  return 'running';
}

function councilDirectory(root, councilId) {
  if (!uuidPattern.test(councilId ?? '')) fail('invalid_request_id', 'council_id must be a canonical UUID.');
  return path.join(root, 'councils', councilId.toLowerCase());
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
