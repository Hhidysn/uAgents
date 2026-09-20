// Local process-level transport fixture: never loads Codex or contacts a provider.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-fixture\n');
} else if (args[0] === 'exec' && args.includes('--json') && args.at(-1) === '-') {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
  const workspace = args[args.indexOf('--cd') + 1];
  const model = args[args.indexOf('--model') + 1];
  if (workspace !== process.cwd() || model !== 'gpt-6-astra' || !prompt.includes('Write the fixture answer.')) {
    process.stderr.write('Invalid fixture invocation.\n');
    process.exitCode = 1;
  } else {
    for (const event of [
      { type: 'thread.started', thread_id: 'codex-real-process-fixture' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Codex subprocess fixture 中文' } },
      { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 5 } },
    ]) process.stdout.write(`${JSON.stringify(event)}\n`);
  }
} else {
  process.stderr.write('Unsupported fixture invocation.\n');
  process.exitCode = 1;
}
