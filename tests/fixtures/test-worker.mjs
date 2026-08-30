import { fileURLToPath } from 'node:url';
import { readJson } from '../../plugins/uagents/skills/agent-dispatch/scripts/store.mjs';
import { work } from '../../plugins/uagents/skills/agent-dispatch/scripts/worker.mjs';
const directory = process.argv[2];
const state = readJson(`${directory}/state.json`);
await work(directory, { command: process.execPath, args: [fileURLToPath(new URL('./fake-agy.mjs', import.meta.url)), state.model_requested.slice('gemini-fixture-'.length)] });
