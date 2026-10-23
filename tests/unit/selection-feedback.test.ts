import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config.js';
import {HarnessRouter} from '../../src/runner.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {workerManifests} from '../../src/workers/registry.js';
import {selectLocal} from '../../src/routing/local.js';
import {applySelectionFeedback, loadSelectionObservations, taskTypeFor} from '../../src/routing/feedback.js';
import type {EligibleRoute} from '../../src/registry/eligibility.js';
import type {SelectionObservation} from '../../src/routing/feedback.js';
import type {DecisionSelector} from '../../src/routing/decision-provider.js';
import type {HarnessAdapter, HarnessResult, HarnessTask} from '../../src/domain/types.js';
import type {RouteProfile} from '../../src/workers/route-profile.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const worker = (id: string, priority = 0): WorkerProfile => ({id, adapter: 'codex', model: 'fixture', enabled: true, allowExecution: true, allowUnknownCost: true, priority});
function candidate(id: string): EligibleRoute {
  const harnessId = id.split(':')[0]!;
  return {harness: workerManifests([worker(harnessId)])[0]!, route: {...workerManifests([worker(harnessId)])[0]!.routes[0]!, id}};
}
const observation = (routeId: string, attempts: number, completed: number, medianTotalMs: number | null, medianTotalTokens: number | null): SelectionObservation => ({routeId, taskType: 'review', attempts, completed, medianTotalMs, medianTotalTokens});

test('task type key matches the performance report', () => {
  assert.equal(taskTypeFor(['Review', 'coding', 'review']), 'coding+review');
  assert.equal(taskTypeFor(['  ']), 'unknown');
});

test('saved observations separate only an equal top priority', () => {
  const fast = candidate('fast-worker:configured');
  const slow = candidate('slow-worker:configured');
  const tied = [worker('fast-worker'), worker('slow-worker')];
  const history = [observation('fast-worker:configured', 4, 4, 100, 20), observation('slow-worker:configured', 4, 1, 50, 10)];
  assert.equal(selectLocal([fast, slow], tied), undefined);
  const winner = applySelectionFeedback([fast, slow], tied, history, 'review');
  assert.equal(winner.route?.route.id, 'fast-worker:configured');
  assert.equal(winner.feedback.applied, true);
  assert.equal(winner.feedback.reason, 'observation_winner');
  const priority = applySelectionFeedback([fast, slow], [worker('fast-worker', 0), worker('slow-worker', 10)], history, 'review');
  assert.equal(priority.route?.route.id, 'slow-worker:configured');
  assert.equal(priority.feedback.applied, false);
  assert.equal(priority.feedback.reason, 'priority_decided');
  const faster = applySelectionFeedback([fast, slow], tied, [observation('fast-worker:configured', 2, 2, 80, 40), observation('slow-worker:configured', 2, 2, 200, 10)], 'review');
  assert.equal(faster.route?.route.id, 'fast-worker:configured');
  const cheaper = applySelectionFeedback([fast, slow], tied, [observation('fast-worker:configured', 2, 2, 80, 40), observation('slow-worker:configured', 2, 2, 80, 10)], 'review');
  assert.equal(cheaper.route?.route.id, 'slow-worker:configured');
  const missingTime = applySelectionFeedback([fast, slow], tied, [observation('fast-worker:configured', 2, 2, null, 10), observation('slow-worker:configured', 2, 2, 50, 100)], 'review');
  assert.equal(missingTime.route?.route.id, 'fast-worker:configured');
  const missingTokens = applySelectionFeedback([fast, slow], tied, [observation('fast-worker:configured', 2, 2, 80, null), observation('slow-worker:configured', 2, 2, 80, 10)], 'review');
  assert.equal(missingTokens.route, undefined);
  assert.equal(missingTokens.feedback.reason, 'observation_tie');
  const unseen = applySelectionFeedback([fast, slow], tied, [observation('fast-worker:configured', 2, 2, 80, 10)], 'review');
  assert.equal(unseen.route, undefined);
  assert.equal(unseen.feedback.reason, 'no_observation_winner');
  const failures = applySelectionFeedback([fast, slow], tied, [observation('fast-worker:configured', 2, 0, null, null), observation('slow-worker:configured', 3, 0, null, null)], 'review');
  assert.equal(failures.route, undefined);
  assert.equal(failures.feedback.reason, 'observation_tie');
  const unavailable = applySelectionFeedback([fast, slow], tied, undefined, 'review');
  assert.equal(unavailable.route, undefined);
  assert.equal(unavailable.feedback.reason, 'observations_unavailable');
  const ranked = applySelectionFeedback([fast, slow], [worker('fast-worker', 1), worker('slow-worker', 0)], undefined, 'review');
  assert.equal(ranked.route?.route.id, 'fast-worker:configured');
  assert.equal(ranked.feedback.reason, 'priority_decided');
});

test('selection feedback ranks named route profiles and leaves the configured route out', () => {
  const review = candidate('codex-main:review');
  const configured = candidate('codex-main:configured');
  const other = candidate('other-worker:configured');
  const profiles = [worker('codex-main', 0), worker('other-worker', 0)];
  const raised: RouteProfile[] = [{id: 'review', harness: 'codex-main', permissions: 'read-only', allowedMcpServers: [], priority: 5}];
  const history = [observation('codex-main:configured', 4, 4, 10, 10), observation('other-worker:configured', 4, 0, 10, 10)];
  const decided = applySelectionFeedback([review, configured, other], profiles, history, 'review', raised);
  assert.equal(decided.route?.route.id, 'codex-main:review');
  assert.equal(decided.feedback.applied, false);
  assert.equal(decided.feedback.reason, 'priority_decided');
  assert.equal(decided.feedback.compared.some(row => row.routeId === 'codex-main:configured'), false);
  const tied: RouteProfile[] = [{id: 'review', harness: 'codex-main', permissions: 'read-only', allowedMcpServers: []}];
  const tiedHistory = [observation('codex-main:review', 4, 4, 100, 20), observation('other-worker:configured', 4, 1, 50, 10)];
  const winner = applySelectionFeedback([review, configured, other], profiles, tiedHistory, 'review', tied);
  assert.equal(winner.route?.route.id, 'codex-main:review');
  assert.equal(winner.feedback.applied, true);
  assert.equal(winner.feedback.reason, 'observation_winner');
  const lower: RouteProfile[] = [{id: 'review', harness: 'codex-main', permissions: 'read-only', allowedMcpServers: [], priority: 1}];
  const workerWins = applySelectionFeedback([review, other], profiles.map(profile => profile.id === 'other-worker' ? {...profile, priority: 10} : profile), undefined, 'review', lower);
  assert.equal(workerWins.route?.route.id, 'other-worker:configured');
  assert.equal(workerWins.feedback.reason, 'priority_decided');
});

test('selection feedback config is off unless set to a boolean', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-feedback-config-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const env = {XDG_CONFIG_HOME: join(root, 'user')};
  assert.equal(loadConfig({cwd: root, env}).selectionFeedback, false);
  assert.equal(loadConfig({cwd: root, env: {...env, ROUTER_SELECTION_FEEDBACK: 'true'}}).selectionFeedback, true);
  await writeFile(join(root, 'on.json'), JSON.stringify({selectionFeedback: true}));
  assert.equal(loadConfig({cwd: root, configPath: join(root, 'on.json'), env}).selectionFeedback, true);
  await writeFile(join(root, 'bad.json'), JSON.stringify({selectionFeedback: 'yes'}));
  assert.throws(() => loadConfig({cwd: root, configPath: join(root, 'bad.json'), env}), /ROUTER_SELECTION_FEEDBACK/);
  await writeFile(join(root, 'unknown.json'), JSON.stringify({selectionHint: true}));
  assert.throws(() => loadConfig({cwd: root, configPath: join(root, 'unknown.json'), env}), /supported settings/);
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'x');
  assert.equal(await loadSelectionObservations(file), undefined);
  assert.deepEqual(await loadSelectionObservations(join(root, 'missing')), []);
});

async function seed(root: string, routeId: string, status: HarnessResult['status'], totalMs: number) {
  const id = randomUUID();
  const directory = join(root, id);
  await mkdir(directory);
  const result: HarnessResult = {schemaVersion: '1.3', runId: id, taskId: id, status, selectedRouteId: routeId, selectedHarnessId: routeId.split(':')[0]!, selectedModelId: 'fixture', artifacts: [], criterionResults: [], timing: {totalMs}, cost: {status: 'unknown'}, usage: [], costComponents: []};
  await writeFile(join(directory, 'result.json'), JSON.stringify(result));
  await writeFile(join(directory, 'task.json'), JSON.stringify({prompt: 'review the fixture', requirements: ['review']}));
}

async function routerFixture(t: {after(fn: () => Promise<void>): void}, profiles: WorkerProfile[], selectionFeedback: boolean, selector: 'local' | 'decisions' = 'local') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-feedback-run-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source');
  const state = join(root, 'state');
  await mkdir(source);
  await mkdir(state);
  const executed: string[] = [];
  const adapters: HarnessAdapter[] = profiles.map(profile => ({id: profile.id, async health() {return {available: true, modelId: 'fixture'};}, async execute() {executed.push(profile.id); return {status: 'completed' as const, summary: 'Reviewed the fixture.', artifacts: [{type: 'text' as const, verified: true}], cost: {status: 'unknown' as const}};}}));
  const config = {...loadConfig({cwd: root, env: {XDG_CONFIG_HOME: join(root, 'user')}}), selector, dryRun: false, allowExecution: true, allowPaid: false, selectionFeedback, workerProfiles: profiles, workspaceRoots: [source], artifactsDir: state};
  const ledger = await BudgetLedger.open(state, 0);
  t.after(() => ledger.close());
  const task: HarnessTask = {schemaVersion: '1.1', taskId: 'feedback-review', prompt: 'Review the fixture', requirements: ['review'], acceptanceCriteria: [], desiredOutput: 'text', allowUnknownCost: true, workspace: {root: source, mode: 'read-only'}, timeoutMs: 5000};
  return {state, source, executed, adapters, config, ledger, task};
}

test('local routing keeps a priority tie unless selection feedback is on', async t => {
  const profiles = [worker('fast-worker'), worker('slow-worker')];
  const off = await routerFixture(t, profiles, false);
  await seed(off.state, 'fast-worker:configured', 'completed', 100);
  await seed(off.state, 'slow-worker:configured', 'failed', 900);
  const tied = await new HarnessRouter(off.config, off.adapters, off.ledger).routeTask(off.task);
  assert.equal(tied.status, 'defer_to_host', JSON.stringify(tied));
  assert.equal(tied.summary, 'Several eligible routes have equal priority. Choose preferredRouteId or configure worker priorities.');
  const tiedDecision = JSON.parse(await readFile(join(off.state, tied.runId, 'decision.json'), 'utf8'));
  assert.equal(tiedDecision.reason, 'local_priority_tie');
  assert.equal('selectionFeedback' in tiedDecision, false);
  assert.deepEqual(off.executed, []);
  const on = await routerFixture(t, profiles, true);
  await seed(on.state, 'fast-worker:configured', 'completed', 100);
  await seed(on.state, 'slow-worker:configured', 'failed', 900);
  const selected = await new HarnessRouter(on.config, on.adapters, on.ledger).routeTask({...on.task, taskId: 'feedback-on'});
  assert.equal(selected.status, 'completed', JSON.stringify(selected.error));
  assert.equal(selected.selectedRouteId, 'fast-worker:configured');
  assert.deepEqual(on.executed, ['fast-worker']);
  const decision = JSON.parse(await readFile(join(on.state, selected.runId, 'decision.json'), 'utf8'));
  assert.equal(decision.reason, 'selection_feedback');
  assert.equal(decision.selectionFeedback.applied, true);
  assert.equal(decision.selectionFeedback.reason, 'observation_winner');
  assert.equal(decision.selectionFeedback.taskType, 'review');
  const ranked = await routerFixture(t, [worker('fast-worker', 0), worker('slow-worker', 10)], true);
  await seed(ranked.state, 'fast-worker:configured', 'completed', 100);
  await seed(ranked.state, 'slow-worker:configured', 'failed', 900);
  const priority = await new HarnessRouter(ranked.config, ranked.adapters, ranked.ledger).routeTask({...ranked.task, taskId: 'priority-wins'});
  assert.equal(priority.selectedRouteId, 'slow-worker:configured', JSON.stringify(priority.error));
  assert.deepEqual(ranked.executed, ['slow-worker']);
  const priorityDecision = JSON.parse(await readFile(join(ranked.state, priority.runId, 'decision.json'), 'utf8'));
  assert.equal(priorityDecision.reason, 'single_eligible_route');
  assert.equal(priorityDecision.selectionFeedback.applied, false);
  assert.equal(priorityDecision.selectionFeedback.reason, 'priority_decided');
  const empty = await routerFixture(t, profiles, true);
  const deferred = await new HarnessRouter(empty.config, empty.adapters, empty.ledger).routeTask({...empty.task, taskId: 'no-history'});
  assert.equal(deferred.status, 'defer_to_host');
  const emptyDecision = JSON.parse(await readFile(join(empty.state, deferred.runId, 'decision.json'), 'utf8'));
  assert.equal(emptyDecision.reason, 'local_priority_tie');
  assert.equal(emptyDecision.selectionFeedback.reason, 'no_observation_winner');
  assert.deepEqual(empty.executed, []);
});

test('hosted selection records feedback and keeps the choice descriptions', async t => {
  const profiles = [worker('fast-worker'), worker('slow-worker')];
  const offered: string[][] = [];
  const decisions: DecisionSelector = {provider: 'openai', requiresPaid: false, reservationUsd: 0, async choose(_task, choices) {offered.push(choices.map(choice => choice.description)); return {routeId: choices[0]!.value, latencyMs: 1, model: 'gpt-6-luna', cost: {status: 'not_applicable', usd: 0}};}};
  const on = await routerFixture(t, profiles, true, 'decisions');
  await seed(on.state, 'fast-worker:configured', 'completed', 100);
  const result = await new HarnessRouter(on.config, on.adapters, on.ledger, decisions).routeTask(on.task);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.deepEqual(offered, [workerManifests(profiles).flatMap(harness => harness.routes.map(route => route.description))]);
  assert.ok(offered[0]!.every(description => !/median|attempts|success/i.test(description)));
  const decision = JSON.parse(await readFile(join(on.state, result.runId, 'decision.json'), 'utf8'));
  assert.equal(decision.selectionFeedback.applied, false);
  assert.equal(decision.selectionFeedback.reason, 'hosted_selector_unchanged');
  assert.equal(decision.selectionFeedback.compared.length, 1);
  const off = await routerFixture(t, profiles, false, 'decisions');
  const plain = await new HarnessRouter(off.config, off.adapters, off.ledger, decisions).routeTask({...off.task, taskId: 'hosted-off'});
  const plainDecision = JSON.parse(await readFile(join(off.state, plain.runId, 'decision.json'), 'utf8'));
  assert.equal('selectionFeedback' in plainDecision, false);
});
