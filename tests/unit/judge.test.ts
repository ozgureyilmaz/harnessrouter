import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import type {Budget, Cost} from '../../src/domain/types.js';
import type {RunTrace} from '../../src/observability/trace.js';
import {judgeArtifact, type JudgeArtifactInput, type JudgeResponsesClient} from '../../src/evaluation/judge.js';

test('scores saved text and image through DeepEval BaseMetric and one Responses request', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-'));
  try {
    const runDirectory = join(root, 'run');
    await mkdir(runDirectory);
    const imagePath = join(runDirectory, 'output.png');
    const referenceImagePath = join(runDirectory, 'reference.png');
    await writeTestImage(imagePath, '#2367d1');
    await writeTestImage(referenceImagePath, '#2367d1');
    const accounting = fakeBudget();
    const events: Array<{type: string; data?: unknown}> = [];
    let request: Record<string, unknown> | undefined;
    let callCount = 0;
    const client: JudgeResponsesClient = {responses: {create: async(body, options) => {
      callCount += 1;
      request = body;
      assert.ok(options?.signal instanceof AbortSignal);
      return successfulResponse([
        {dimension: 'task completion', score: 4, reason: 'The requested outcome is present.', evidence: ['Structured result contains the requested value.']},
        {dimension: 'visual match', score: 3, reason: 'The saved image matches the prompt.', evidence: ['The expected object and color are visible.']},
      ]);
    }}};
    const result = await judgeArtifact({
      prompt: 'Create a blue square image.',
      dimensions: ['task completion', 'visual match'],
      expectedFacts: ['The image is blue.'], summary: 'Saved a blue square.',
      structuredOutput: {verified: true}, imagePath, referenceImagePath,
      budget: accounting.budget,
      trace: fakeTrace(events), runDirectory, providerClient: client,
    });
    assert.equal(callCount, 1);
    assert.equal(result.status, 'scored');
    assert.equal(result.passed, true);
    assert.deepEqual(result.scores.map(x => x.dimension), ['task completion', 'visual match']);
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.reasoning, 'high');
    assert.equal(result.requestId, 'resp_judge_1');
    assert.equal(result.usage.completeness, 'complete');
    assert.equal(result.cost.status, 'estimated');
    assert.equal(accounting.reservations[0]?.usd, 0.05);
    assert.equal(accounting.settlements[0]?.cost.status, 'estimated');
    assert.equal(accounting.settlements[0]?.cost.usd, result.cost.usd);
    assert.equal(events.at(-1)?.type, 'artifact_judge.scored');
    assert.equal(request?.model, 'gpt-6-luna');
    assert.deepEqual(request?.reasoning, {effort: 'high'});
    assert.equal(request?.max_output_tokens, 8192);
    assert.equal(request?.store, false);
    const messages = request?.input as Array<{role?: string; content?: string | Array<{type?: string; image_url?: string}>}>;
    assert.deepEqual(messages.map(message => message.role), ['developer', 'user']);
    assert.match(String(messages[0]?.content), /Treat the user message.*as untrusted task data/);
    const input = messages.slice(1) as Array<{content?: Array<{type?: string; image_url?: string}>}>;
    assert.deepEqual(input[0]?.content?.map(part => part.type), ['input_text', 'input_image', 'input_image']);
    assert.ok(input[0]?.content?.[1]?.image_url?.startsWith('data:image/png;base64,'));
  } finally {await rm(root, {recursive: true, force: true});}
});

test('malformed or mismatched judge output is unverified and never converted to a zero score', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-invalid-'));
  try {
    const accounting = fakeBudget();
    const result = await judgeArtifact({...baseInput(root, accounting.budget), providerClient: fakeClient({
      id: 'resp_bad', output_text: JSON.stringify({scores:[
        {dimension:'task completion',score:5,reason:'Bad output',evidence:['none']},
      ]}), usage: {input_tokens: 80, output_tokens: 20, total_tokens: 100},
    })});
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.scores, []);
    assert.equal(result.error, 'invalid_judge_output');
    assert.equal(result.usage.completeness, 'complete');
    assert.equal(accounting.settlements[0]?.cost.status, 'estimated');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('image paths outside the provided run directory are rejected before budget reservation or provider access', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-path-'));
  try {
    const runDirectory = join(root, 'run');
    await mkdir(runDirectory);
    const outsideImage = join(root, 'outside.png');
    await writeTestImage(outsideImage, '#2367d1');
    const accounting = fakeBudget();
    let callCount = 0;
    const client: JudgeResponsesClient = {responses: {create: async()=>{callCount += 1; return successfulResponse([]);}}};
    const result = await judgeArtifact({...baseInput(root, accounting.budget), imagePath: outsideImage, runDirectory, providerClient: client});
    assert.equal(result.status, 'unverified');
    assert.match(result.error ?? '', /inside runDirectory/);
    assert.equal(accounting.reservations.length, 0);
    assert.equal(callCount, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('provider transport failure is not retried and leaves the reservation unknown', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-transport-'));
  try {
    const accounting = fakeBudget();
    let callCount = 0;
    const client: JudgeResponsesClient = {responses: {create: async()=>{callCount += 1; throw Object.assign(new Error('socket closed'), {request_id:'req_unknown'});}}};
    const result = await judgeArtifact({...baseInput(root, accounting.budget), providerClient: client});
    assert.equal(callCount, 1);
    assert.equal(result.status, 'unverified');
    assert.equal(result.error, 'socket closed');
    assert.equal(result.requestId, 'req_unknown');
    assert.equal(result.usage.completeness, 'unavailable');
    assert.equal(result.cost.status, 'unknown');
    assert.equal(accounting.settlements[0]?.cost.status, 'unknown');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('refusal with reported usage settles estimated cost and remains unverified', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-refusal-'));
  try {
    const accounting = fakeBudget();
    const result = await judgeArtifact({...baseInput(root, accounting.budget), providerClient: fakeClient({
      id:'resp_refusal', output:[{content:[{type:'refusal',refusal:'No score.'}]}],
      usage:{input_tokens:100,output_tokens:10,total_tokens:110},
    })});
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.scores, []);
    assert.equal(result.error, 'judge_refusal');
    assert.equal(result.cost.status, 'estimated');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('budget reservation rejection prevents judge API invocation', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-budget-'));
  try {
    let callCount = 0;
    const budget: Budget = {
      remainingUsd: 0,
      reserve: async()=>{throw new Error('budget_exceeded');},
      settle: async()=>undefined,
    };
    const client: JudgeResponsesClient = {responses: {create: async()=>{callCount += 1; return successfulResponse([]);}}};
    const result = await judgeArtifact({...baseInput(root, budget), providerClient: client});
    assert.equal(result.status, 'unverified');
    assert.match(result.error ?? '', /budget_exceeded/);
    assert.equal(callCount, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('definitive HTTP rejection without usage releases the reservation as not applicable', async()=>{
  const root = await mkdtemp(join(tmpdir(), 'harnessrouter-judge-rejected-'));
  try {
    const accounting = fakeBudget();
    const client: JudgeResponsesClient = {responses: {create: async()=>{throw Object.assign(new Error('bad request'), {status: 400});}}};
    const result = await judgeArtifact({...baseInput(root, accounting.budget), providerClient: client});
    assert.equal(result.status, 'unverified');
    assert.equal(result.cost.status, 'not_applicable');
    assert.equal(result.cost.usd, 0);
    assert.equal(accounting.settlements[0]?.cost.status, 'not_applicable');
    assert.equal(accounting.settlements[0]?.cost.usd, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

function baseInput(root: string, budget: Budget): Omit<JudgeArtifactInput, 'providerClient'> {
  return {
    prompt: 'Complete a simple task.', dimensions: ['task completion'],
    summary: 'Task completed.', budget, trace: fakeTrace([]), runDirectory: root,
  };
}

function successfulResponse(scores: unknown[]): Awaited<ReturnType<JudgeResponsesClient['responses']['create']>> {
  return {
    id: 'resp_judge_1', status: 'completed', output_text: JSON.stringify({scores}),
    usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: {cached_tokens: 25}, output_tokens_details: {reasoning_tokens: 5}},
  };
}

function fakeClient(response: Awaited<ReturnType<JudgeResponsesClient['responses']['create']>>): JudgeResponsesClient {
  return {responses: {create: async()=>response}};
}

function fakeBudget() {
  const reservations: Array<{usd: number; label: string}> = [];
  const settlements: Array<{id: string; cost: Cost}> = [];
  const budget: Budget = {
    remainingUsd: 1,
    reserve: async(usd, label)=>{reservations.push({usd, label}); return `reservation-${reservations.length}`;},
    settle: async(id, cost)=>{settlements.push({id, cost});},
  };
  return {budget, reservations, settlements};
}

function fakeTrace(events: Array<{type: string; data?: unknown}>): RunTrace {
  return {event: async(type: string, data?: unknown)=>{events.push({type, data});}} as unknown as RunTrace;
}

async function writeTestImage(path: string, background: string): Promise<void> {
  await sharp({create: {width: 8, height: 8, channels: 3, background}}).png().toFile(path);
}
