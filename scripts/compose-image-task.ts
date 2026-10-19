import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig} from '../src/config.js';
import {imageTaskFromBrowserRun} from '../src/tasks/compose-image.js';
import type {HarnessResult} from '../src/domain/types.js';

const runId = process.argv[2];
if (!runId || process.argv.length !== 3) {
  console.error('Usage: npm run task:compose -- <browser-run-id>');
  process.exitCode = 1;
} else {
  const config = loadConfig();
  const result = JSON.parse(await readFile(join(config.artifactsDir, runId, 'result.json'), 'utf8')) as HarnessResult;
  console.log(JSON.stringify(imageTaskFromBrowserRun(runId, result, config.imageRoute), null, 2));
}
