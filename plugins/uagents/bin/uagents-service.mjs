#!/usr/bin/env node
import { main } from '../mcp/unified/dist/service.mjs';
process.exitCode = await main();
