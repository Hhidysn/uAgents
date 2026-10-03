#!/usr/bin/env node
import { main } from '../src/checkin/run.mjs';
process.exitCode = await main();
