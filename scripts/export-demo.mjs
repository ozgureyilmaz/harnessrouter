// Explicit offline export: never reads .env or submits provider requests.
import {readFile, writeFile, mkdir, copyFile, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'demo/preview');
const readJson = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const writeJson = async (path, data) => {
  await mkdir(dirname(resolve(destination, path)), {recursive: true});
  await writeFile(resolve(destination, path), JSON.stringify(data, null, 2) + '\n');
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const finite = value => Number.isFinite(value) && value >= 0;
const timing = value => Object.fromEntries(
  ['totalMs', 'decisionMs', 'executionMs', 'handoffMs', 'verificationMs']
    .filter(key => finite(value?.[key])).map(key => [key, value[key]]),
);
const cost = value => ({
  status: ['estimated', 'unknown', 'not_applicable', 'provider_reported', 'rate_estimate'].includes(value?.status) ? value.status : 'unknown',
  ...(finite(value?.usd) ? {usd: value.usd} : {}),
});

const metrics = await readJson('demo/metrics.json');
const native = (await readJson('demo/native-mcp-verification.json')).finalP0Verification;
if (native?.status !== 'passed' || native.runs?.length !== 2) throw new Error('Verified native two-run evidence is required.');
const [browser, creative] = native.runs;
if (creative.parentRunId !== browser.runId) throw new Error('Native composition parent mismatch.');
const codexRecord = await readJson('demo/codex-only-run.json');
let publicCodex = codexRecord;
let codexImage;
if (codexRecord.status !== 'awaiting_user_run') {
  // This captured record and PNG were explicitly inspected for publication.
  // A future run needs a new review rather than copying arbitrary local files.
  if (codexRecord.runId !== '9df28c6c-f5cb-4c9e-91f2-0ae30bf0c98a' || codexRecord.status !== 'partial') {
    throw new Error('Review the new Codex-only record before exporting.');
  }
  const directory = `artifacts/codex-only/${codexRecord.runId}`;
  const metadata = await readJson(`${directory}/image-output.json`);
  const verification = await readJson(`${directory}/verification.json`);
  const bytes = await readFile(resolve(root, directory, 'hero.png'));
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256 ||
      metadata.width !== 1672 || metadata.height !== 940 || verification.exact16by9 !== false ||
      verification.sourceSiteFreshBrowserVerified !== false) throw new Error('Codex-only verification changed; review required.');
  codexImage = {source: `${directory}/hero.png`, sha256: metadata.sha256, width: metadata.width, height: metadata.height};
  const summaries = {
    'inspect-site': 'Native web retrieval succeeded; a fresh isolated browser and rendered screenshot were unavailable in this run.',
    'measure-style': 'Rendered visual-style measurements were unavailable.',
    'create-image': 'Native image generation returned a real 1672×940 PNG; source-style match is unverified.',
    'verify-output': 'PNG integrity passed. Exact 16:9 failed; source-site style matching remains unverified.',
  };
  publicCodex = {
    schemaVersion: codexRecord.schemaVersion, status: codexRecord.status, runId: codexRecord.runId,
    mode: codexRecord.mode, taskId: codexRecord.taskId, taskPrompt: codexRecord.taskPrompt,
    execution: {
      codexModel: codexRecord.execution.codexModel, toolsUsed: codexRecord.execution.toolsUsed,
      startedAt: codexRecord.execution.startedAt, completedAt: codexRecord.execution.completedAt,
      durationMs: codexRecord.execution.durationMs,
    },
    steps: codexRecord.steps.map(step => ({id: step.id, label: step.label, status: step.status,
      summary: summaries[step.id], durationMs: step.durationMs})),
    artifacts: [{path: 'assets/codex-only-hero.png', label: 'Native hero draft · 1672×940 · exact 16:9 failed · site style unverified',
      sha256: metadata.sha256, width: metadata.width, height: metadata.height}],
    cost: {status: 'unknown', amountUsd: null},
    outcomeNote: 'Partial native-only browser-to-image run: public text was retrieved and a real draft was generated. Fresh browser inspection and rendered style measurements were unavailable in that run. Exact 16:9 failed; site-style matching is unverified. Model identity and total USD are unknown. Duration includes orchestration and user interruption; it is not comparable to router processing time.',
  };
}
for (const run of native.runs) {
  if (!uuid.test(run.runId)) throw new Error('Invalid recorded run ID.');
  const original = await readJson(`artifacts/${run.runId}/result.json`);
  if (original.status !== 'completed' || original.schemaVersion !== run.schemaVersion ||
      original.selectedRouteId !== run.selectedRouteId || original.timing.totalMs !== run.timing.totalMs) {
    throw new Error(`Native evidence no longer matches saved result: ${run.runId}`);
  }
}

// Copy only the two reviewed public demo images, validating recorded hashes.
const assets = [];
for (const [run, name] of [[browser, 'site-screenshot.png'], [creative, 'generated-hero.png']]) {
  const artifact = run.artifacts[0];
  if (!artifact || !new RegExp(`^artifacts/${run.runId}/[\\w.-]+\\.png$`).test(artifact.path)) throw new Error('Unexpected asset path.');
  const source = resolve(root, artifact.path);
  if (!(await lstat(source)).isFile()) throw new Error('Asset must be a regular file.');
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Recorded asset hash mismatch.');
  await mkdir(resolve(destination, 'assets'), {recursive: true});
  await copyFile(source, resolve(destination, 'assets', name));
  assets.push({path: `assets/${name}`, runId: run.runId, sha256: artifact.sha256, width: artifact.width, height: artifact.height});
}
if (codexImage) await copyFile(resolve(root, codexImage.source), resolve(destination, 'assets/codex-only-hero.png'));

// Deliberate field allowlist: no raw prompts, DOM, file paths, budget ledger,
// provider URLs, request headers, or arbitrary provider result objects.
const runs = metrics.runs.map(record => {
  const result = record.result ?? record;
  if (!uuid.test(record.runId)) throw new Error('Invalid metrics run ID.');
  return {
    runId: record.runId,
    kind: record.kind,
    status: result.status ?? (record.kind === 'baseline.json' ? 'completed' : 'unknown'),
    selectedRouteId: result.selectedRouteId ?? record.routeId ?? (record.kind === 'baseline.json' ? 'direct-fal' : record.kind === 'direct-comparison.json' ? 'direct-provider' : result.selectedHarnessId),
    schemaVersion: result.schemaVersion,
    timing: timing({...record.timing, ...result.timing,
      totalMs: result.timing?.totalMs ?? record.timing?.totalMs ?? record.elapsedMs}),
    cost: cost(result.cost),
    ...(result.error?.code ? {error: {code: result.error.code}} : {}),
    evidenceFile: `data/runs/${record.runId}.json`,
  };
});
if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('Duplicate run records require explicit export review.');
for (const run of runs) await writeJson(run.evidenceFile, {...run, evidenceFile: undefined});

// Use an actual matched baseline; do not pair metrics from unrelated runs.
const baseline = await readJson('artifacts/bf16042b-1cf6-43c0-94cd-bbfd29b62944/baseline.json');
const reference = runs.find(run => run.runId === baseline.referenceRunId);
if (!reference || reference.timing.totalMs !== baseline.specialistTiming.totalMs) throw new Error('Baseline reference mismatch.');
const snapshot = {
  schemaVersion: '1.0', generatedAt: metrics.generatedAt, exportedAt: new Date().toISOString(),
  mode: 'RECORDED_PUBLIC_SNAPSHOT',
  liveExecutionAttempts: metrics.liveExecutionAttempts,
  verifiedCompletedExecutions: metrics.verifiedCompletedExecutions,
  decisions: {attempts: metrics.decisions.attempts, validSelections: metrics.decisions.validSelections, failures: metrics.decisions.failures},
  runs,
  composite: {browserRunId: browser.runId, creativeRunId: creative.runId, routerProcessingSumMs: native.composition.routerProcessingSumMs},
  featured: {verifiedAt: native.verifiedAt, resultSchema: '1.2', sourceFingerprint: native.sourceFingerprint, assets, limits: native.limits},
  baselineComparison: {
    baselineRunId: baseline.runId, specialistRunId: baseline.referenceRunId,
    baselineTiming: timing(baseline.timing), specialistTiming: timing(baseline.specialistTiming),
    limits: baseline.comparisonLimits,
  },
  limits: ['Snapshot of local development runs, not a controlled reliability benchmark.',
    'Mechanical completion is not artistic quality or full task success.',
    'Host Codex and Pi OAuth USD are unknown; rate estimates are not invoices.',
    `Historical failures and cancelled runs are retained. Native Codex-only workflow status: ${publicCodex.status}.`],
};
await writeJson('data/metrics.json', snapshot);
await writeJson('data/codex-only-run.json', publicCodex);
await writeFile(resolve(destination, '.nojekyll'), '');
console.log(`Exported ${runs.length} sanitized router records, ${assets.length} original workflow images, and Codex-only status ${publicCodex.status}. No API calls.`);
