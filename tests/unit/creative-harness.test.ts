import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {Budget, ExecutionContext, HarnessTask, Route} from '../../src/domain/types.js';
import {CreativeHarness} from '../../src/harnesses/fal-creative.js';
import {FalSubmitRetrySuppressedError, createFalQueuePort, type FalQueuePort, type FalModelId} from '../../src/harnesses/creative/fal-queue.js';
import {planCreativeTask} from '../../src/harnesses/creative/planner.js';

const fastRoute: Route = {
  id: 'fal-creative:image-fast', description: 'fast', generation_model_id: 'fal-ai/flux/schnell',
  modalities: ['image'], eligible_requirements: ['text_to_image'], price_usd: 0.003,
  price_status: 'estimated', enabled: true,
};

const meta = {mimeType: 'image/png', width: 1000, height: 1000, bytes: 8, sha256: 'a'.repeat(64)};

function makeBudget(): Budget & {reservations: number[]; settlements: unknown[]} {
  const budget = {
    remainingUsd: 0.25,
    reservations: [] as number[],
    settlements: [] as unknown[],
    async reserve(usd: number) {this.reservations.push(usd); return 'reservation-1';},
    async settle(_id: string, cost: unknown) {this.settlements.push(cost);},
  };
  return budget;
}

function makeTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    schemaVersion: '1.0', taskId: 'task-creative', prompt: 'An orange cat in a garden',
    requirements: ['text_to_image'], acceptanceCriteria: ['verified image'], desiredOutput: 'image',
    allowPaidExecution: true, ...overrides,
  };
}

function makeContext(artifactsDir: string, budget = makeBudget(), runId = 'run-creative'): ExecutionContext {
  return {
    runId, routeId: fastRoute.id, route: fastRoute, budgetUsd: 0.25,
    signal: new AbortController().signal, artifactsDir, budget,
    trace: {event: async () => undefined},
  };
}

class FakeQueue implements FalQueuePort {
  submissions = 0;
  statusCalls = 0;
  cancelCalls = 0;
  shouldFailSubmit = false;
  get submissionAttempted() {return this.submissions > 0;}
  get suppressedRetry() {return false;}
  get retryableHttpStatus() {return undefined;}

  async submit(_modelId: FalModelId, _input: unknown, _signal: AbortSignal) {
    this.submissions++;
    if (this.shouldFailSubmit) throw new TypeError('connection reset after submission');
    return {requestId: 'fal-request-1'};
  }
  async status(_modelId: FalModelId, _requestId: string, _signal: AbortSignal) {
    this.statusCalls++;
    return {status: this.statusCalls > 1 ? 'COMPLETED' : 'IN_QUEUE'};
  }
  async result() {
    return {data: {images: [{url: 'https://fal.media/image.png', content_type: 'image/png'}], has_nsfw_concepts: [false], seed: 7}};
  }
  async cancel() {this.cancelCalls++;}
}

async function testDependencies(directory: string) {
  const budget = makeBudget();
  const queue = new FakeQueue();
  const harness = new CreativeHarness({
    apiKey: 'unit-test-key', allowPaid: true, dryRun: false, queue, pollIntervalMs: 1,
    downloadImage: async (_url, destination) => {
      await writeFile(destination, 'mock');
      return meta;
    },
    verifyImage: async () => meta,
  });
  return {budget, queue, harness, ctx: makeContext(directory, budget)};
}

test('refuses paid execution unless the task carries explicit authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harnessrouter-creative-'));
  try {
    const {queue, harness, ctx} = await testDependencies(directory);
    const result = await harness.execute(makeTask({allowPaidExecution: false}), ctx);
    assert.equal(result.status, 'permission_required');
    assert.equal(queue.submissions, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('submits once, validates the downloaded artifact and settles the price estimate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harnessrouter-creative-'));
  try {
    const {budget, queue, harness, ctx} = await testDependencies(directory);
    const result = await harness.execute(makeTask(), ctx);
    assert.equal(result.status, 'completed');
    assert.equal(queue.submissions, 1);
    assert.equal(result.artifacts[0]?.verified, true);
    assert.equal(result.selectedModelId, 'fal-ai/flux/schnell');
    assert.equal(result.structuredOutput?.expectedAspectRatio, 1);
    assert.deepEqual(budget.reservations, [0.003]);
    assert.equal(budget.settlements.length, 1);
    const cached = await harness.execute(makeTask(), ctx);
    assert.equal(cached.status, 'completed');
    assert.equal(queue.submissions, 1);
    assert.deepEqual(budget.reservations, [0.003]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('does not resubmit after a queue submission becomes ambiguous', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harnessrouter-creative-'));
  try {
    const {queue, harness, ctx} = await testDependencies(directory);
    queue.shouldFailSubmit = true;
    const first = await harness.execute(makeTask(), ctx);
    const second = await harness.execute(makeTask(), ctx);
    assert.equal(first.error?.code, 'reconciliation_required');
    assert.equal(second.error?.code, 'reconciliation_required');
    assert.equal(queue.submissions, 1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('fal SDK queue retry attempts cannot create a second paid POST', async () => {
  const planned = planCreativeTask(makeTask(), makeContext('/tmp/fal-queue-test'));
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const controller = new AbortController();
  let outboundPosts = 0;
  const queue = createFalQueuePort({
    apiKey: 'unit-test-key', signal: controller.signal,
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method?.toUpperCase(), 'POST');
      outboundPosts++;
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    queue.submit('fal-ai/flux/schnell', planned.plan.input, controller.signal),
    error => error instanceof FalSubmitRetrySuppressedError,
  );
  assert.equal(outboundPosts, 1);
  assert.equal(queue.suppressedRetry, true);
});

test('mocked creative: host cancellation requests provider cancel without resubmission',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'harnessrouter-cancel-'));
  try{
    const {queue,harness,ctx}=await testDependencies(directory);const controller=new AbortController();ctx.signal=controller.signal;
    const original=queue.submit.bind(queue);queue.submit=async(...args)=>{const result=await original(...args);setTimeout(()=>controller.abort(),5);return result;};
    queue.status=async()=>({status:'IN_QUEUE'});
    const result=await harness.execute(makeTask(),ctx);assert.equal(result.status,'cancelled');assert.equal(queue.submissions,1);assert.equal(queue.cancelCalls,1);assert.equal(result.cost.status,'unknown');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('mocked creative: timeout retains ambiguous charge and cancels accepted request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'harnessrouter-timeout-'));
  try{
    const queue=new FakeQueue();queue.status=async()=>({status:'IN_QUEUE'});
    const harness=new CreativeHarness({apiKey:'unit-test-key',allowPaid:true,dryRun:false,queue,pollIntervalMs:1,timeoutMs:100});
    const result=await harness.execute(makeTask(),makeContext(directory));assert.equal(result.status,'failed');assert.equal(queue.submissions,1);assert.equal(queue.cancelCalls,1);assert.equal(result.cost.status,'unknown');
  }finally{await rm(directory,{recursive:true,force:true});}
});
