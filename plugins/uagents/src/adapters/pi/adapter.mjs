import { CliAdapter } from '../cli-base.mjs';

export class PiAdapter extends CliAdapter {
  constructor(options) { super('pi', options); }
}
