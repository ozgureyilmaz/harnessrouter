import assert from 'node:assert/strict';
import test from 'node:test';
import type {Budget, Cost, HarnessTask, TraceSink} from '../../src/domain/types.js';
import {RouterError} from '../../src/domain/errors.js';
import {DecisionsClient, parseDecision} from '../../src/routing/decisions.js';

const choices = [
  {value: 'pi-browser:configured', description: 'Public browser work'},
  {value: 'native:defer', description: 'Host-owned coding work'},
];

function task(): HarnessTask {
  return {
    schemaVersion: '1.0', taskId: 'decision-test', prompt: 'Read a public page and report its title.',
    requirements: ['browser'], acceptanceCriteria: ['Return the title'],
    allowedDomains: ['example.com'], desiredOutput: 'text',
  };
}

function response(choice = choices[0]!.value, extra: Record<string, unknown> = {}) {
  return {
    model: 'gpt-6-luna',
    answers: [{type: 'choice', name: 'execution_route', choice, confidence: 0.84, probabilities: [
      {value: choices[0]!.value, probability: 0.84},
      {value: choices[1]!.value, probability: 0.16},
    ]}],
    usage: {input_tokens: 500, output_tokens: 3, total_tokens: 503},
    ...extra,
  };
}

class FakeBudget implements Budget {
  remainingUsd = 1;
  reservations: {amount: number; label: string; id: string}[] = [];
  settlements: {id: string; cost: Cost}[] = [];
  async reserve(usd: number, label: string): Promise<string> {
    if (usd > this.remainingUsd) throw new RouterError('budget_exceeded', 'Insufficient budget');
    this.remainingUsd -= usd;
    const id = `reservation-${this.reservations.length + 1}`;
    this.reservations.push({amount: usd, label, id});
    return id;
  }
  async settle(id: string, cost: Cost): Promise<void> { this.settlements.push({id, cost}); }
}

function fakeTrace() {
  const events: {type: string; data?: unknown}[] = [];
  const trace: TraceSink = {event: async (type, data) => {events.push({type, data});}};
  return {trace, events};
}

function clientFor(data: unknown, options: {requestId?: string | null; error?: Error} = {}) {
  const calls: {body: unknown; requestOptions: unknown}[] = [];
  const client = {
    decisions: {
      create(body: unknown, requestOptions: unknown) {
        calls.push({body, requestOptions});
        return {withResponse: async () => {
          if (options.error) throw options.error;
          return {data, request_id: options.requestId ?? 'req-test-1'};
        }};
      },
    },
  };
  return {client, calls};
}

test('parser accepts only the one named offered route and optional bounded metadata', () => {
  const parsed = parseDecision(response(), choices);
  assert.equal(parsed.routeId, 'pi-browser:configured');
  assert.equal(parsed.model, 'gpt-6-luna');
  assert.equal(parsed.confidence, 0.84);
  assert.deepEqual(parsed.probabilities?.map(item => item.value), choices.map(choice => choice.value));
  assert.deepEqual(parsed.usage, {input_tokens: 500, output_tokens: 3, total_tokens: 503});

  const noMetadata = parseDecision({model: 'gpt-6-luna', answers: [{type: 'choice', name: 'execution_route', choice: choices[1]!.value}]}, choices);
  assert.equal(noMetadata.routeId, 'native:defer');
  assert.equal(noMetadata.confidence, undefined);
  assert.equal(noMetadata.probabilities, undefined);
});

test('parser rejects refusal, malformed answers, unknown route IDs, and invalid metadata', () => {
  assert.throws(() => parseDecision({model: 'gpt-6-luna', answers: [{type: 'refusal', name: 'execution_route'}]}, choices), {code: 'decision_refused'});
  assert.throws(() => parseDecision({model: 'gpt-6-luna', answers: [{type: 'refusal', name: 'other_question'}]}, choices), {code: 'invalid_decision'});
  assert.throws(() => parseDecision({model: 'gpt-6-luna', answers: []}, choices), {code: 'invalid_decision'});
  assert.throws(() => parseDecision(response('invented:route'), choices), {code: 'invalid_decision'});
  assert.throws(() => parseDecision(response(choices[0]!.value, {
    answers: [{type: 'choice', name: 'wrong_question', choice: choices[0]!.value}],
  }), choices), {code: 'invalid_decision'});
  assert.throws(() => parseDecision({
    model: 'gpt-6-luna', answers: [{type: 'choice', name: 'execution_route', choice: choices[0]!.value, confidence: 1.2}],
  }, choices), {code: 'invalid_decision'});
  assert.throws(() => parseDecision({
    model: 'gpt-6-luna', answers: [{type: 'choice', name: 'execution_route', choice: choices[0]!.value, probabilities: [{value: 'other', probability: 0.5}]}],
  }, choices), {code: 'invalid_decision'});
  assert.throws(() => parseDecision({model: 'gpt-6-luna', answers: [
    {type: 'choice', name: 'execution_route', choice: choices[0]!.value},
    {type: 'choice', name: 'another', choice: choices[1]!.value},
  ]}, choices), {code: 'invalid_decision'});
});

test('client reserves and settles cost, uses one offered choice, and records a safe trace', async () => {
  const fake = clientFor(response(), {requestId: 'req-decisions-42'});
  const budget = new FakeBudget();
  const {trace, events} = fakeTrace();
  const client = new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false});
  const result = await client.choose(task(), choices, new AbortController().signal, trace, budget);

  assert.equal(result.routeId, 'pi-browser:configured');
  assert.equal(result.providerDecisionId, 'req-decisions-42');
  assert.equal(result.cost.status, 'estimated');
  assert.equal(result.cost.usd, 0.00005);
  assert.equal(budget.reservations[0]?.amount, 0.01);
  assert.equal(budget.settlements[0]?.cost.usd, 0.00005);
  assert.equal(fake.calls.length, 1);
  assert.equal((fake.calls[0]?.requestOptions as {maxRetries: number}).maxRetries, 0);
  assert.deepEqual(events.map(event => event.type), ['decision.requested', 'decision.response', 'decision.completed']);
  const sentRequest = ((events[0]?.data as {request: {input: string; questions: {choices: {description: string}[]}[]}}).request);
  assert.equal(sentRequest.input.includes(task().prompt), true);
  assert.equal(sentRequest.questions[0]?.choices[0]?.description, choices[0]?.description);
  const savedResponse = (events[1]?.data as {response: {answers: unknown[]; model: string}}).response;
  assert.equal(savedResponse.model, 'gpt-6-luna');
  assert.equal(savedResponse.answers.length, 1);
});

test('client settles usage before rejecting a malformed provider selection', async () => {
  const fake = clientFor(response('invented:route'));
  const budget = new FakeBudget();
  const {trace, events} = fakeTrace();
  const client = new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false});
  await assert.rejects(client.choose(task(), choices, new AbortController().signal, trace, budget), {code: 'invalid_decision'});
  assert.equal(budget.settlements[0]?.cost.usd, 0.00005);
  assert.equal(events.at(-1)?.type, 'decision.invalid_response');
  assert.equal(fake.calls.length, 1);
});

test('client never calls provider without approval, during dry run, or without choices', async () => {
  const fake = clientFor(response());
  const trace = fakeTrace().trace;
  const budget = new FakeBudget();
  const signal = new AbortController().signal;

  await assert.rejects(new DecisionsClient({client: fake.client as never, allowPaid: false, dryRun: false}).choose(task(), choices, signal, trace, budget), {code: 'paid_execution_not_authorized'});
  await assert.rejects(new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: true}).choose(task(), choices, signal, trace, budget), {code: 'dry_run_execution_disabled'});
  await assert.rejects(new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false}).choose(task(), [], signal, trace, budget), {code: 'no_eligible_route'});
  await assert.rejects(new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false}).choose(task(), choices.slice(0, 1), signal, trace, budget), {code: 'decision_requires_multiple_choices'});
  assert.equal(fake.calls.length, 0);
  assert.equal(budget.reservations.length, 0);
});

test('ambiguous transport failures are settled unknown and never retried', async () => {
  const error = new Error('connection closed');
  error.name = 'APIConnectionError';
  const fake = clientFor(undefined, {error});
  const budget = new FakeBudget();
  const {trace, events} = fakeTrace();
  const client = new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false});
  await assert.rejects(client.choose(task(), choices, new AbortController().signal, trace, budget), {code: 'decision_network_error'});
  assert.equal(fake.calls.length, 1);
  assert.equal(budget.settlements[0]?.cost.status, 'unknown');
  assert.equal(events.at(-1)?.type, 'decision.failed');
});

test('provider HTTP failures expose only redacted bounded scalar diagnostics', async () => {
  const cases = [
    {status: 401, expected: 'auth_invalid'},
    {status: 403, expected: 'access_denied'},
    {status: 404, expected: 'endpoint_unavailable'},
    {status: 400, expected: 'invalid_request'},
  ];
  for (const entry of cases) {
    const providerError = Object.assign(new Error('SDK wrapper should not replace provider detail'), {
      status: entry.status,
      code: 'invalid_model',
      param: 'model',
      error: {message: `Provider says Bearer do-not-log-${entry.status} is invalid.`},
      headers: new Headers({'authorization': 'Bearer header-secret'}),
      request: {body: 'raw request must not be traced'},
    });
    const fake = clientFor(undefined, {error: providerError});
    const budget = new FakeBudget();
    const {trace, events} = fakeTrace();
    const client = new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false});

    await assert.rejects(
      client.choose(task(), choices, new AbortController().signal, trace, budget),
      error => error instanceof RouterError && error.code === entry.expected && !error.message.includes('do-not-log'),
    );
    const failure = events.at(-1)!;
    assert.equal(failure.type, 'decision.failed');
    const data = failure.data as Record<string, unknown>;
    assert.equal(data.providerStatus, entry.status);
    assert.equal(data.providerCode, 'invalid_model');
    assert.equal(data.providerParam, 'model');
    assert.equal(typeof data.providerMessage, 'string');
    assert.equal((data.providerMessage as string).includes('do-not-log'), false);
    assert.equal('headers' in data, false);
    assert.equal('request' in data, false);
    assert.equal(JSON.stringify(data).includes('header-secret'), false);
    assert.equal(budget.settlements[0]?.cost.status, 'unknown');
  }
});

test('provider error messages are capped at 500 characters', async () => {
  const providerError = Object.assign(new Error('fallback'), {
    status: 400,
    code: 'invalid_request',
    error: {message: 'x'.repeat(900)},
  });
  const fake = clientFor(undefined, {error: providerError});
  const {trace, events} = fakeTrace();
  const client = new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false});
  await assert.rejects(client.choose(task(), choices, new AbortController().signal, trace, new FakeBudget()), {code: 'invalid_request'});
  const message = (events.at(-1)?.data as {providerMessage: string}).providerMessage;
  assert.equal(message.length, 500);
});

test('client honors the budget ledger before making a provider request', async () => {
  const fake = clientFor(response());
  const budget = new FakeBudget();
  budget.remainingUsd = 0.005;
  const client = new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false});
  await assert.rejects(client.choose(task(), choices, new AbortController().signal, fakeTrace().trace, budget), {code: 'budget_exceeded'});
  assert.equal(fake.calls.length, 0);
});

test('request size is bounded, task context is omitted, and option descriptions are capped', async () => {
  const fake = clientFor(response());
  const budget = new FakeBudget();
  const {trace, events} = fakeTrace();
  const largeTask: HarnessTask = {
    ...task(), prompt: 'routing-prompt-'.repeat(800),
    acceptanceCriteria: Array.from({length: 100}, () => 'criterion '.repeat(100)),
    context: {
      url: 'https://private.example/should-not-be-sent', secret: 'do-not-forward',
      creativeOptions: {aspectRatio: '16:9', quality: 'high', style: 'soft editorial illustration'},
    },
    allowedDomains: Array.from({length: 100}, (_, index) => `domain-${index}.example`),
  };
  const largeChoices = choices.map(choice => ({...choice, description: 'description '.repeat(200)}));
  await new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false})
    .choose(largeTask, largeChoices, new AbortController().signal, trace, budget);

  const sent = fake.calls[0]?.body as {input: string; questions: {choices: {description: string}[]}[]};
  assert.ok(sent.input.length < 20_500);
  assert.equal(sent.input.includes('should-not-be-sent'), false);
  assert.equal(sent.input.includes('do-not-forward'), false);
  assert.equal(sent.input.includes('Validated creative options: {"aspectRatio":"16:9","style":"soft editorial illustration","quality":"high"}'), true);
  assert.ok(sent.questions[0]!.choices.every(choice => choice.description.length <= 500));
  const traced = (events[0]?.data as {request: typeof sent}).request;
  assert.deepEqual(traced, sent);
});

test('unknown creative context fields are not forwarded to Decisions', async () => {
  const fake = clientFor(response());
  const invalidCreativeTask = {...task(), context: {creativeOptions: {quality: 'high', privateHint: 'do-not-send'}}};
  await new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false})
    .choose(invalidCreativeTask, choices, new AbortController().signal, fakeTrace().trace, new FakeBudget());
  const sent = fake.calls[0]?.body as {input: string};
  assert.equal(sent.input.includes('do-not-send'), false);
  assert.equal(sent.input.includes('Validated creative options'), false);
});

test('image routing tells Decisions that unspecified quality defaults to balanced', async () => {
  const fake = clientFor(response());
  const imageTask: HarnessTask = {
    ...task(), prompt: 'Create a hero image.', requirements: ['text_to_image', 'image'], desiredOutput: 'image',
  };
  await new DecisionsClient({client: fake.client as never, allowPaid: true, dryRun: false})
    .choose(imageTask, choices, new AbortController().signal, fakeTrace().trace, new FakeBudget());
  const sent = fake.calls[0]?.body as {input: string};
  assert.equal(sent.input.includes('Validated creative options: {"quality":"balanced"}'), true);
});

test('client pins the documented selection model', () => {
  assert.throws(() => new DecisionsClient({model: 'gpt-6-sol', allowPaid: true, dryRun: false}), {code: 'invalid_config'});
});
