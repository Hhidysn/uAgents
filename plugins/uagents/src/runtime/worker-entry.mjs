import { pathToFileURL } from 'node:url';

export async function runWorkerEntry({ factoryFile, taskId }) {
  const factory = await import(pathToFileURL(factoryFile).href);
  if (typeof factory.run !== 'function') throw new Error('Worker factory must export run(taskId).');
  return factory.run(taskId);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [, , factoryFile, taskId] = process.argv;
  if (!factoryFile || !taskId) throw new Error('Usage: worker-entry.mjs FACTORY_FILE TASK_ID');
  await runWorkerEntry({ factoryFile, taskId });
}
