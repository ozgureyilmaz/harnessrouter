// Buildless Pages check: uses Node built-ins and never reads credentials.
import assert from 'node:assert/strict';
import {readFile, readdir, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../demo/preview');
const readJson = async path => JSON.parse(await readFile(resolve(directory, path), 'utf8'));
const snapshot = await readJson('data/metrics.json');
assert.equal(snapshot.mode, 'RECORDED_PUBLIC_SNAPSHOT');
const allowed = new Set(['index.html', 'evidence.html', 'README.md', '.nojekyll',
  'data/metrics.json', 'data/codex-only-run.json', 'data/browser-comparison.json',
  'browser-comparison.js', 'browser-comparison.css']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const secretPattern = /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:OPENAI_API_KEY|FAL_KEY)\s*[:=]\s*["']?[A-Za-z0-9_-]{10,}|(?:Bearer\s+)[A-Za-z0-9_-]{20,}/;
const privatePath = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|file:\/\/|\.\.\/artifacts\/)/;

for (const run of snapshot.runs) {
  assert.match(run.runId, uuid);
  assert.equal(run.evidenceFile, `data/runs/${run.runId}.json`);
  allowed.add(run.evidenceFile);
  const record = await readJson(run.evidenceFile);
  const {evidenceFile, ...expected} = run;
  assert.deepEqual(record, expected, `Record mismatch: ${run.runId}`);
  assert(Object.keys(record).every(key => ['runId', 'kind', 'status', 'selectedRouteId', 'schemaVersion', 'timing', 'cost', 'error'].includes(key)));
}
assert.equal(new Set(snapshot.runs.map(run => run.runId)).size, snapshot.runs.length);
const executionRuns = snapshot.runs.filter(run => run.selectedRouteId !== 'native:defer');
assert.equal(snapshot.liveExecutionAttempts, executionRuns.length);
assert.equal(snapshot.verifiedCompletedExecutions, executionRuns.filter(run => run.status === 'completed').length);
assert.equal(snapshot.decisions.attempts, snapshot.decisions.validSelections + snapshot.decisions.failures);
const browser = snapshot.runs.find(run => run.runId === snapshot.composite.browserRunId);
const creative = snapshot.runs.find(run => run.runId === snapshot.composite.creativeRunId);
assert.equal(browser?.schemaVersion, '1.2');
assert.equal(creative?.schemaVersion, '1.2');
assert.equal(browser.status, 'completed');
assert.equal(creative.status, 'completed');
assert.equal(snapshot.composite.routerProcessingSumMs, browser.timing.totalMs + creative.timing.totalMs);
const baseline = snapshot.runs.find(run => run.runId === snapshot.baselineComparison.baselineRunId);
const reference = snapshot.runs.find(run => run.runId === snapshot.baselineComparison.specialistRunId);
assert.equal(snapshot.baselineComparison.baselineTiming.totalMs, baseline.timing.totalMs);
assert.equal(snapshot.baselineComparison.specialistTiming.totalMs, reference.timing.totalMs);
for (const asset of snapshot.featured.assets) {
  assert.match(asset.path, /^assets\/[\w-]+\.png$/);
  allowed.add(asset.path);
  const bytes = await readFile(resolve(directory, asset.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), asset.width);
  assert.equal(bytes.readUInt32BE(20), asset.height);
}
assert.equal(snapshot.featured.assets.length, 2);
// Preserve the separately captured browser-only pilot and validate its assets.
const pilot = await readJson('data/browser-comparison.json');
assert.equal(pilot.schemaVersion, '1.0');
assert.equal(pilot.native.checks.filter(check => check.status === 'passed').length, 4);
assert.equal(pilot.routed.checks.filter(check => check.status === 'passed').length, 3);
assert.equal(pilot.routed.status, 'partial');
for (const arm of [pilot.native, pilot.routed]) {
  assert.match(arm.screenshotPath, /^assets\/browser-pilot\/(?:codex-browser\.jpg|pi-browser\.png)$/);
  allowed.add(arm.screenshotPath);
  const bytes = await readFile(resolve(directory, arm.screenshotPath));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), arm.sha256);
}
const codex = await readJson('data/codex-only-run.json');
assert(['awaiting_user_run', 'partial'].includes(codex.status));
for (const artifact of codex.artifacts) {
  assert.equal(artifact.path, 'assets/codex-only-hero.png');
  allowed.add(artifact.path);
  const bytes = await readFile(resolve(directory, artifact.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  assert.equal(bytes.readUInt32BE(16), artifact.width);
  assert.equal(bytes.readUInt32BE(20), artifact.height);
  assert.notEqual(artifact.width * 9, artifact.height * 16);
}
if (codex.status === 'partial') {
  assert.equal(codex.steps.find(step => step.id === 'verify-output').status, 'failed');
  assert.equal(codex.steps.find(step => step.id === 'measure-style').status, 'unsupported');
}

async function inspect(path = '') {
  for (const name of await readdir(resolve(directory, path))) {
    const entry = path ? `${path}/${name}` : name;
    const info = await lstat(resolve(directory, entry));
    assert(!info.isSymbolicLink(), `Symlink not allowed in public demo: ${entry}`);
    if (info.isDirectory()) { await inspect(entry); continue; }
    assert(allowed.has(entry), `Unexpected public file: ${entry}`);
    if (!entry.endsWith('.png')) {
      const text = await readFile(resolve(directory, entry), 'utf8');
      assert(!secretPattern.test(text), `Possible credential in public file: ${entry}`);
      assert(!privatePath.test(text), `Private local path in public file: ${entry}`);
    }
  }
}
await inspect();
for (const page of ['index.html', 'evidence.html']) {
  const html = await readFile(resolve(directory, page), 'utf8');
  assert(!/(?:fetch\(["']\.\.\/|(?:src|href)=["'](?:\/|\.\.\/))/.test(html), `Nonportable path: ${page}`);
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(script, {filename: page});
  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g), ...html.matchAll(/fetch\(["']([^"']+)["']/g)];
  for (const [, value] of references) {
    if (/^(?:https?:|#)/.test(value)) continue;
    const path = relative(directory, resolve(directory, value.split(/[?#]/)[0]));
    assert(!path.startsWith('..') && allowed.has(path), `Unexpected link in ${page}: ${value}`);
    assert((await lstat(resolve(directory, path))).isFile());
  }
}
const index = await readFile(resolve(directory, 'index.html'), 'utf8');
for (const run of [browser, creative]) assert(index.includes(`${(run.timing.totalMs / 1000).toFixed(2)} s`), 'Featured timing drift');
new Script(await readFile(resolve(directory, 'browser-comparison.js'), 'utf8'));
console.log(`PASS: ${snapshot.runs.length} public records, ${4 + codex.artifacts.length} original image hashes, featured PNG dimensions, portable links, JavaScript syntax, and public file boundary.`);
