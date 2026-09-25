import { CliAdapter } from '../cli-base.mjs';

export class ClaudeCodeAdapter extends CliAdapter {
  constructor(options = {}) { super('claudeCode', options); }
}
