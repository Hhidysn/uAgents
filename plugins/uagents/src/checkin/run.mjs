import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runCheckins } from './checkin.mjs';

export async function main(argv = process.argv.slice(2), io = console) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: {
      target: { type: 'string', multiple: true }, 'check-only': { type: 'boolean' },
      'report-file': { type: 'string' },
    } });
    if (positionals.length) throw new Error();
    const result = await runCheckins({ targets: values.target, checkOnly: values['check-only'] === true });
    if (values['report-file']) {
      const file = path.resolve(values['report-file']);
      const temporary = `${file}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    io.log(JSON.stringify({ ok: true, data: result }));
    return result.results.some(item => ['failed', 'unconfirmed'].includes(item.status)) ? 1 : 0;
  } catch { io.log(JSON.stringify({ ok: false, error: { code: 'checkin_unavailable', message: 'Check-in could not be completed.' } })); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
