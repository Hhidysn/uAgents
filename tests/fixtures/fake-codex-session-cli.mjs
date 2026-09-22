// A real subprocess fixture for the Codex exec/resume/fork CLI contract.
// Never imports Codex or contacts a provider; thread state is local to cwd.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const journal = path.join(process.cwd(), '.codex-session-fixture.json');
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-session-fixture\n');
} else if (args[0] === 'exec' && args.includes('--json') && args.at(-1) === '-') {
  const action = ['resume', 'fork'].includes(args[1]) ? args[1] : 'start';
  const index = args.indexOf('--model');
  const model = args[index + 1];
  const source = action === 'start' ? null : args.at(-2);
  const workspace = args[args.indexOf('--cd') + 1];
  const flags = ['--last', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', '--skip-git-repo-check'];
  if (model !== 'gpt-5.6-luna' || flags.some(flag => args.includes(flag)) ||
      action === 'start' && (workspace !== process.cwd() || !args.includes('--cd')) ||
      action !== 'start' && args.includes('--cd')) {
    process.stderr.write('Invalid fixture argv.\n');
    process.exitCode = 1;
  } else {
    let prompt = '';
    for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
    const state = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')) : { threads: {}, calls: [] };
    if (!prompt.includes('uAgents task workspace:') || !prompt.includes('fixture-turn-') ||
        action !== 'start' && !state.threads[source]) {
      process.stderr.write('Invalid fixture source or stdin.\n');
      process.exitCode = 1;
    } else {
      const thread = action === 'resume' ? source : randomUUID();
      if (action !== 'resume') state.threads[thread] = action === 'fork' ? [...state.threads[source]] : [];
      state.threads[thread].push(prompt.slice(prompt.lastIndexOf('fixture-turn-')));
      state.calls.push({ action, source, thread, model, prompt });
      fs.writeFileSync(journal, JSON.stringify(state));
      for (const event of [
        { type: 'thread.started', thread_id: thread },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: `fixture ${action} ${state.threads[thread].length}` } },
        { type: 'turn.completed', usage: { input_tokens: 6, output_tokens: 3 } },
      ]) process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  }
} else {
  process.stderr.write('Unsupported Codex fixture invocation.\n');
  process.exitCode = 1;
}
