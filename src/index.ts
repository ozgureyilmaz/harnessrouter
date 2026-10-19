#!/usr/bin/env node
import {runCli} from './cli.js';
try{process.exitCode=await runCli(process.argv.slice(2));}
catch(error){process.stderr.write(`harnessrouter: ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;}
