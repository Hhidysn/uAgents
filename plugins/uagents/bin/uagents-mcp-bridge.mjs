#!/usr/bin/env node
import { main } from '../mcp/unified/dist/bridge.mjs';
process.exitCode = await main();
