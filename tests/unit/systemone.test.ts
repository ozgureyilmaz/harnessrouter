import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {SystemOneDecisionsClient, validateSystemOneBaseUrl} from '../../src/routing/systemone.js';
import {RouterError} from '../../src/domain/errors.js';
import type {Budget, Cost, HarnessTask, TraceSink} from '../../src/domain/types.js';
import type {DecisionHttpTransport} from '../../src/routing/decision-http.js';
const choices = [{value: 'worker:one', description: 'First authorized worker'}, {value: 'native:defer', description: 'Return to host'}];
const task: HarnessTask = {schemaVersion: '1.1', taskId: 'fixture', prompt: 'Inspect the supplied project', requirements: ['review'], acceptanceCriteria: ['Return findings'], context: {private_data: 'never-send-context'}};
function answer(extra: Record<string, unknown> = {}) {return {model: 'jev-1.13.0', answers: {execution_route: {type: 'choice', choice: choices[0]!.value, confidence: .8, probabilities: {[choices[0]!.value]: .8, [choices[1]!.value]: .2}}}, usage: {input_tokens: 100, output_tokens: 4}, ...extra};}
class FakeBudget implements Budget {
  remainingUsd = 1; reservations: number[] = []; settlements: Cost[] = [];
  async reserve(usd: number) {if (usd > this.remainingUsd) throw new RouterError('budget_exceeded', 'Insufficient fixture budget'); this.reservations.push(usd); this.remainingUsd -= usd; return `fixture-${this.reservations.length}`;}
  async settle(_id: string, cost: Cost) {this.settlements.push(cost); if (cost.status === 'not_applicable') this.remainingUsd += this.reservations.at(-1)!;}
}
function trace() {const events: Array<{type: string; data?: unknown}> = []; return {events, sink: {event: async (type: string, data?: unknown) => {events.push({type, data});}} satisfies TraceSink};}
const signal = () => new AbortController().signal;
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void|Promise<void>, run: (baseUrl: string) => Promise<void>) {
  const server = createServer((req, res) => {void handler(req, res);}); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);} finally {server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));}
}

test('mocked Jev uses official System One maps, safe metadata, and an unresolved paid reservation', async () => {
  let request: Parameters<DecisionHttpTransport>[0]|undefined;
  const budget = new FakeBudget(); const log = trace();
  const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture-key', allowPaid: true, dryRun: false, transport: async (input) => {request = input; return {data: answer(), requestId: 'req-fixture'};}});
  const result = await client.choose(task, choices, signal(), log.sink, budget);
  assert.equal(request!.url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(request!.apiKey, 'fixture-key');
  const body = request!.body as {model: string; state: string; questions: Record<string, {type: string; criteria: Record<string, string>}>};
  assert.equal(body.model, 'jev-latest'); assert.ok(body.state.includes(task.prompt)); assert.ok(!body.state.includes('never-send-context'));
  assert.deepEqual(Object.keys(body.questions), ['execution_route']); assert.equal(body.questions.execution_route!.type, 'choice');
  assert.deepEqual(body.questions.execution_route!.criteria, Object.fromEntries(choices.map((choice) => [choice.value, choice.description])));
  assert.equal(result.routeId, 'worker:one'); assert.equal(result.model, 'jev-1.13.0'); assert.equal(result.provider, 'jev'); assert.equal(result.cost.status, 'unknown');
  assert.deepEqual(budget.reservations, [.01]); assert.equal(budget.settlements[0]!.status, 'unknown'); assert.equal(budget.remainingUsd, .99);
  assert.deepEqual(log.events.map((event) => event.type), ['decision.requested', 'decision.response', 'decision.completed']);
  assert.ok(!JSON.stringify(log.events).includes('fixture-key')); assert.ok(!JSON.stringify(log.events).includes(task.prompt));
});

test('offline provider origin validation prevents hosted redirects, non-loopback local URLs and URL credential/path leakage', () => {
  assert.equal(validateSystemOneBaseUrl('jev', 'https://api.typesafe.ai/'), 'https://api.typesafe.ai');
  assert.equal(validateSystemOneBaseUrl('ollaya', 'http://localhost:11435'), 'http://localhost:11435');
  assert.equal(validateSystemOneBaseUrl('ollaya', 'https://[::1]:11435'), 'https://[::1]:11435');
  for (const value of ['http://api.typesafe.ai', 'https://other.example', 'https://api.typesafe.ai:444', 'https://key@api.typesafe.ai', 'https://api.typesafe.ai/v1', 'https://api.typesafe.ai?token=secret', 'https://api.typesafe.ai#x']) assert.throws(() => validateSystemOneBaseUrl('jev', value), {code: 'invalid_config'});
  for (const value of ['http://example.com', 'http://127.0.0.2', 'file:///tmp/socket', 'http://localhost:11435/v1', 'http://user:secret@localhost:11435']) assert.throws(() => validateSystemOneBaseUrl('ollaya', value), {code: 'invalid_config'});
});

test('mocked Jev key, paid, dry-run, budget and abort guards prevent all requests', async () => {
  let requests = 0; const transport: DecisionHttpTransport = async () => {requests++; return {data: answer()};};
  for (const [overrides, code] of [[{apiKey: undefined}, 'credential_missing:jev'], [{allowPaid: false}, 'paid_execution_not_authorized'], [{dryRun: true}, 'dry_run_execution_disabled']] as const) {
    const budget = new FakeBudget(); const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture', allowPaid: true, dryRun: false, transport, ...overrides});
    await assert.rejects(client.choose(task, choices, signal(), trace().sink, budget), {code}); assert.deepEqual(budget.reservations, []);
  }
  const budget = new FakeBudget(); budget.remainingUsd = 0;
  const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture', allowPaid: true, dryRun: false, transport});
  await assert.rejects(client.choose(task, choices, signal(), trace().sink, budget), {code: 'budget_exceeded'});
  await assert.rejects(client.choose(task, choices, AbortSignal.abort(), trace().sink, new FakeBudget()), {code: 'cancelled'});
  assert.equal(requests, 0);
});

test('mocked invalid maps, unknown IDs and invalid confidence/probabilities fail closed with no retry', async () => {
  const invalid = [
    {answers: {}}, {answers: {execution_route: {type: 'choice', choice: 'invented'}}},
    {answers: {execution_route: {type: 'choice', choice: 'worker:one'}, extra: {type: 'choice'}}},
    ...[{confidence: 2}, {confidence: null}, {probabilities: []}, {probabilities: {'unknown:id': .8}}, {probabilities: {'worker:one': -1}}, {probabilities: {'worker:one': NaN}}, {probabilities: {'worker:one': Infinity}}].map((metadata) => ({answers: {execution_route: {type: 'choice', choice: 'worker:one', ...metadata}}})),
  ];
  for (const extra of invalid) {
    let count = 0; const log = trace(); const budget = new FakeBudget();
    const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture', allowPaid: true, dryRun: false, transport: async () => {count++; return {data: answer(extra)};}});
    await assert.rejects(client.choose(task, choices, signal(), log.sink, budget), {code: 'invalid_decision'});
    assert.equal(count, 1); assert.equal(log.events.at(-1)!.type, 'decision.invalid_response'); assert.equal(budget.settlements[0]!.status, 'unknown');
  }
});

test('mocked refusal and absent optional metadata are preserved without fabricated confidence', async () => {
  const log = trace(); const refused = new SystemOneDecisionsClient({provider: 'ollaya', allowPaid: false, dryRun: false, transport: async () => ({data: answer({answers: {execution_route: {type: 'refusal'}}})})});
  await assert.rejects(refused.choose(task, choices, signal(), log.sink, new FakeBudget()), {code: 'decision_refused'}); assert.equal(log.events.at(-1)!.type, 'decision.refused');
  const plain = new SystemOneDecisionsClient({provider: 'ollaya', allowPaid: false, dryRun: false, transport: async () => ({data: answer({answers: {execution_route: {type: 'choice', choice: 'native:defer'}}, usage: {output_tokens: 0}})})});
  const result = await plain.choose(task, choices, signal(), trace().sink, new FakeBudget());
  assert.equal(result.confidence, undefined); assert.equal(result.probabilities, undefined); assert.deepEqual(result.usage, {output_tokens: 0});
});

test('mocked ambiguous hosted failure retains commitment; pre-request trace failure releases it', async () => {
  const budget = new FakeBudget(); const log = trace(); let calls = 0;
  const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture', allowPaid: true, dryRun: false, transport: async () => {calls++; throw new Error('fixture-sensitive-body');}});
  await assert.rejects(client.choose(task, choices, signal(), log.sink, budget), {code: 'decision_network_error'});
  assert.equal(calls, 1); assert.equal(budget.settlements[0]!.status, 'unknown'); assert.equal(budget.remainingUsd, .99); assert.ok(!JSON.stringify(log.events).includes('fixture-sensitive-body'));
  const before = new FakeBudget(); const brokenTrace: TraceSink = {event: async () => {throw new Error('fixture trace failed');}};
  await assert.rejects(client.choose(task, choices, signal(), brokenTrace, before), /fixture trace failed/);
  assert.equal(calls, 1); assert.equal(before.settlements[0]!.status, 'not_applicable'); assert.equal(before.remainingUsd, 1);
});

test('loopback-only fixture Ollaya uses optional auth, typed model default and no provider budget', async () => {
  let calls = 0;
  await fixture(async (req, res) => {
    calls++; assert.equal(req.url, '/v1/systemone'); assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, undefined);
    const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString()); assert.equal(body.model, 'laya:typed-decisions'); assert.equal(body.questions.execution_route.type, 'choice');
    res.setHeader('x-typesafe-request-id', 'local-fixture-1'); res.setHeader('x-private-header', 'never-logged'); res.end(JSON.stringify(answer({model: 'laya:typed-decisions'})));
  }, async (baseUrl) => {
    const budget = new FakeBudget(); budget.remainingUsd = 0; const log = trace();
    const client = new SystemOneDecisionsClient({provider: 'ollaya', baseUrl, allowPaid: false, dryRun: false});
    const result = await client.choose(task, choices, signal(), log.sink, budget);
    assert.equal(result.providerDecisionId, 'local-fixture-1'); assert.equal(result.cost.status, 'not_applicable'); assert.equal(result.cost.usd, 0);
    assert.deepEqual(budget.reservations, []); assert.deepEqual(budget.settlements, []); assert.ok(!JSON.stringify(log.events).includes('never-logged'));
  });
  assert.equal(calls, 1);
});

test('loopback-only fixtures keep a short JSON provider error and hide raw bodies', async () => {
  await fixture((_req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({error: 'model "missing-model:latest" not found, try pulling it first', code: 'MODEL_NOT_FOUND', detail: 'fixture-sensitive-body'}));
  }, async (baseUrl) => {
    const client = new SystemOneDecisionsClient({provider: 'ollaya', baseUrl, allowPaid: false, dryRun: false});
    await assert.rejects(client.choose(task, choices, signal(), trace().sink, new FakeBudget()), (error: unknown) => {
      assert.ok(error instanceof RouterError);
      assert.equal(error.code, 'decision_model_unavailable');
      assert.match(error.message, /not installed/);
      assert.match(error.message, /\. Provider message: /);
      assert.match(error.message, /missing-model:latest/);
      assert.equal(error.message.includes('fixture-sensitive-body'), false);
      return true;
    });
  });
  await fixture((_req, res) => {
    res.statusCode = 422;
    res.end(JSON.stringify({error: 'state: Field required', code: 'INVALID_REQUEST'}));
  }, async (baseUrl) => {
    const client = new SystemOneDecisionsClient({provider: 'ollaya', baseUrl, allowPaid: false, dryRun: false});
    await assert.rejects(client.choose(task, choices, signal(), trace().sink, new FakeBudget()), (error: unknown) => error instanceof RouterError && error.code === 'invalid_request' && error.message.includes('state: Field required'));
  });
});

test('loopback-only fixtures reject redirects, 413/422, oversized and malformed bodies without retries or error leakage', async () => {
  for (const mode of ['redirect', '413', '422', 'size', 'malformed']) {
    let calls = 0;
    await fixture((_req, res) => {
      calls++; res.setHeader('x-typesafe-request-id', 'fixture-error-id');
      if (mode === 'redirect') {res.statusCode = 307; res.setHeader('location', 'http://example.com/private'); res.end('fixture-sensitive-body');}
      else if (mode === '413' || mode === '422') {res.statusCode = Number(mode); res.end('fixture-sensitive-body');}
      else if (mode === 'size') res.end('x'.repeat(1024 * 1024 + 1));
      else res.end('fixture-sensitive-body');
    }, async (baseUrl) => {
      const client = new SystemOneDecisionsClient({provider: 'ollaya', baseUrl, allowPaid: false, dryRun: false}); const log = trace();
      const code = mode === 'redirect' ? 'decision_redirect_denied' : mode === 'size' ? 'decision_response_limit' : mode === 'malformed' ? 'invalid_decision' : 'invalid_request';
      await assert.rejects(client.choose(task, choices, signal(), log.sink, new FakeBudget()), (error: unknown) => error instanceof RouterError && error.code === code && !error.message.includes('fixture-sensitive-body'));
      assert.ok(!JSON.stringify(log.events).includes('fixture-sensitive-body'));
    });
    assert.equal(calls, 1);
  }
});

test('loopback-only fixtures enforce total timeout and cancellation without fallback', async () => {
  for (const abort of [false, true]) {
    let calls = 0; const controller = new AbortController();
    await fixture((_req, _res) => {calls++; if (abort) controller.abort();}, async (baseUrl) => {
      const client = new SystemOneDecisionsClient({provider: 'ollaya', baseUrl, timeoutMs: 50, allowPaid: false, dryRun: false});
      await assert.rejects(client.choose(task, choices, controller.signal, trace().sink, new FakeBudget()), {code: abort ? 'cancelled' : 'decision_timeout'});
    });
    assert.equal(calls, 1);
  }
});


test('mocked invalid offered choices never reach the transport or reserve a hosted budget', async () => {
  let calls = 0; const budget = new FakeBudget();
  const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture', allowPaid: true, dryRun: false, transport: async () => {calls++; return {data: answer()};}});
  for (const offered of [[], [choices[0]!], [choices[0]!, choices[0]!], [choices[0]!, {...choices[1]!, description: ''}]]) await assert.rejects(client.choose(task, offered, signal(), trace().sink, budget));
  assert.equal(calls, 0); assert.deepEqual(budget.reservations, []);
});

test('mocked settlement and response trace failures cannot return a hosted route or release an unknown charge', async () => {
  const budget = new FakeBudget(); budget.settle = async () => {throw new Error('fixture settlement failed');};
  const client = new SystemOneDecisionsClient({provider: 'jev', apiKey: 'fixture', allowPaid: true, dryRun: false, transport: async () => ({data: answer()})});
  await assert.rejects(client.choose(task, choices, signal(), trace().sink, budget), {code: 'budget_settlement_failed'});
  const accounted = new FakeBudget();
  await assert.rejects(client.choose(task, choices, signal(), {event: async (type) => {if (type === 'decision.response') throw new Error('fixture trace failure');}}, accounted), {code: 'trace_write_failed'});
  assert.equal(accounted.settlements[0]!.status, 'unknown'); assert.equal(accounted.remainingUsd, .99);
});

test('mocked local dry run remains disabled without accessing even an injected local transport', async () => {
  let calls = 0;
  const client = new SystemOneDecisionsClient({provider: 'ollaya', allowPaid: false, dryRun: true, transport: async () => {calls++; return {data: answer()};}});
  await assert.rejects(client.choose(task, choices, signal(), trace().sink, new FakeBudget()), {code: 'dry_run_execution_disabled'}); assert.equal(calls, 0);
});
