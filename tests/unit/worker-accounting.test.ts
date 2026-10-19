import test from 'node:test';
import assert from 'node:assert/strict';
import {codexWorker} from '../../src/workers/codex.js';
import {claudeCodeWorker} from '../../src/workers/claude-code.js';
import {piWorker} from '../../src/workers/pi.js';
import {openCodeWorker} from '../../src/workers/opencode.js';
import {normalizePiUsage, normalizeUsageRecord} from '../../src/observability/metering.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const profile: WorkerProfile = {id: 'fixture', adapter: 'codex', model: 'fixture', provider: 'fixture', enabled: true, allowExecution: true};
const done = {type: 'item.completed', item: {type: 'agent_message', text: 'Done'}};
const claudeResult = {type: 'result', subtype: 'success', is_error: false, result: 'Done'};
const claudeMessage = (id: string|undefined, usage?: unknown) => ({type: 'assistant', message: {id, model: 'fixture', content: [{type: 'text', text: 'Done'}], usage}});
const piMessage = (usage?: unknown, responseId?: string) => ({type: 'message_end', message: {role: 'assistant', provider: 'fixture', model: 'fixture', responseId, stopReason: 'stop', content: [{type: 'text', text: 'Done'}], usage}});
const parsePi = (messages: Record<string, unknown>[]) => piWorker.parse([{type: 'response', id: 'task', command: 'prompt', success: true}, ...messages, {type: 'agent_end'}], profile);
const ocStep = (tokens?: unknown, id?: string) => ({type: 'step_finish', sessionID: 'fixture-session', part: {id, reason: 'stop', tokens}});
const parseOpenCode = (steps: Record<string, unknown>[]) => openCodeWorker.parse([{type: 'text', sessionID: 'fixture-session', part: {text: 'Done'}}, ...steps], profile);
const anthropic = {input_tokens: 300, cache_read_input_tokens: 90, cache_creation_input_tokens: 2, output_tokens: 40};
const canonical = {inputTokens: 392, outputTokens: 40, cachedInputTokens: 90, cacheWriteInputTokens: 2, totalTokens: 432};

test('mocked canonical accounting includes cache input and reasoning output exactly once across runtimes', () => {
  const pi = parsePi([piMessage({input: 300, output: 40, cacheRead: 90, cacheWrite: 2, reasoning: 8, totalTokens: 432})]);
  const oc = parseOpenCode([ocStep({input: 300, output: 32, reasoning: 8, cache: {read: 90, write: 2}, total: 432})]);
  const claude = claudeCodeWorker.parse([claudeMessage('message-1', anthropic), claudeResult], profile);
  assert.deepEqual(pi.usage![0]!.tokens, {...canonical, reasoningOutputTokens: 8});
  assert.deepEqual(oc.usage![0]!.tokens, {...canonical, reasoningOutputTokens: 8});
  assert.deepEqual(claude.usage![0]!.tokens, canonical);
  for (const result of [pi, oc, claude]) {
    assert.equal(result.usage![0]!.completeness, 'complete');
    assert.ok(result.usage![0]!.source.endsWith('.canonical_v1'));
  }
});

test('mocked Codex completed turns remain distinct; identified duplicate snapshots merge and missing turns stay unavailable', () => {
  const parsed = codexWorker.parse([done,
    {type: 'turn.completed', turn_id: 't1', usage: {input_tokens: 100, cached_input_tokens: 20}},
    {type: 'turn.completed', turn_id: 't1', usage: {input_tokens: 100, output_tokens: 10}},
    {type: 'turn.completed', usage: {input_tokens: 50, output_tokens: 5}},
    {type: 'turn.completed'},
  ], profile);
  assert.equal(parsed.usage!.length, 3);
  assert.deepEqual(parsed.usage![0]!.tokens, {inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, totalTokens: 110});
  assert.deepEqual(parsed.usage![1]!.tokens, {inputTokens: 50, outputTokens: 5, totalTokens: 55});
  assert.deepEqual(parsed.usage![2]!.tokens, {});
  assert.equal(parsed.usage![2]!.completeness, 'unavailable');
  assert.equal(parsed.usage![2]!.measurement, 'unavailable');
});

test('mocked Claude cumulative snapshots merge by message ID and aggregate usage never adds them twice', () => {
  const parsed = claudeCodeWorker.parse([
    claudeMessage('m1', {...anthropic, output_tokens: 10}),
    claudeMessage('m1', {output_tokens: 40}),
    claudeMessage('m1', anthropic),
    claudeMessage('m2', anthropic),
    {...claudeResult, usage: {...anthropic, input_tokens: 600, output_tokens: 80}},
  ], profile);
  assert.equal(parsed.usage!.length, 2);
  assert.deepEqual(parsed.usage!.map((record) => record.tokens), [canonical, canonical]);
  assert.ok(parsed.usage!.every((record) => record.completeness === 'complete'));
  const fallback = claudeCodeWorker.parse([claudeMessage('m1'), {...claudeResult, usage: anthropic}], profile);
  assert.equal(fallback.usage!.length, 1); assert.deepEqual(fallback.usage![0]!.tokens, canonical);
  assert.equal(fallback.usage![0]!.source, 'claude_code_result_usage.canonical_v1');
});

test('mocked missing Claude cache or output counters are absent; anonymous messages stay separate and partial', () => {
  const missing = claudeCodeWorker.parse([claudeMessage('m1', {input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 90}), claudeMessage('m2', {cache_read_input_tokens: 10}), claudeResult], profile);
  assert.deepEqual(missing.usage![0]!.tokens, {outputTokens: 40, cachedInputTokens: 90});
  assert.deepEqual(missing.usage![1]!.tokens, {cachedInputTokens: 10});
  assert.ok(missing.usage!.every((record) => record.completeness === 'partial'));
  const anonymous = claudeCodeWorker.parse([claudeMessage(undefined, anthropic), claudeMessage(undefined, anthropic), claudeResult], profile);
  assert.equal(anonymous.usage!.length, 2); assert.ok(anonymous.usage!.every((record) => record.completeness === 'partial'));
  const unavailable = claudeCodeWorker.parse([claudeResult], profile).usage![0]!;
  assert.equal(unavailable.measurement, 'unavailable'); assert.equal(unavailable.completeness, 'unavailable'); assert.deepEqual(unavailable.tokens, {});
});

test('mocked Pi/OpenCode duplicate native completion identities do not duplicate counters; missing usage stays unavailable', () => {
  const nativePi = {input: 300, output: 40, cacheRead: 90, cacheWrite: 2, totalTokens: 432};
  assert.equal(parsePi([piMessage(nativePi, 'r1'), piMessage(nativePi, 'r1')]).usage!.length, 1);
  const nativeOpenCode = {input: 300, output: 32, reasoning: 8, cache: {read: 90, write: 2}, total: 432};
  assert.equal(parseOpenCode([ocStep(nativeOpenCode, 'part-1'), ocStep(nativeOpenCode, 'part-1')]).usage!.length, 1);
  for (const record of [parsePi([piMessage()]).usage![0]!, parseOpenCode([ocStep()]).usage![0]!]) {
    assert.equal(record.completeness, 'unavailable'); assert.equal(record.measurement, 'unavailable'); assert.deepEqual(record.tokens, {});
  }
  const partialPi = parsePi([piMessage({input: 300, output: 40, cacheRead: 90})]).usage![0]!;
  assert.deepEqual(partialPi.tokens, {outputTokens: 40, cachedInputTokens: 90}); assert.equal(partialPi.completeness, 'partial');
  const partialOpenCode = parseOpenCode([ocStep({input: 300, output: 32, cache: {read: 90, write: 2}})]).usage![0]!;
  assert.deepEqual(partialOpenCode.tokens, {inputTokens: 392, cachedInputTokens: 90, cacheWriteInputTokens: 2});
  assert.equal(partialOpenCode.completeness, 'partial');
});

test('mocked normalization preserves reported contradictions as partial, maps SDK reasoning, and never fabricates empty counters', () => {
  const conflict = normalizeUsageRecord({provider: 'fixture', source: 'fixture', measurement: 'provider_reported', counters: {inputTokens: 10, outputTokens: 5, cachedInputTokens: 9, cacheWriteInputTokens: 3, totalTokens: 999, reasoning: 6}});
  assert.equal(conflict.completeness, 'partial'); assert.equal(conflict.tokens.totalTokens, 999); assert.equal(conflict.tokens.reasoningOutputTokens, 6);
  const pi = normalizePiUsage({provider: 'fixture', counters: {input: 300, output: 40, cacheRead: 90, cacheWrite: 2, reasoning: 8, totalTokens: 432}});
  assert.deepEqual(pi.tokens, {...canonical, reasoningOutputTokens: 8});
  const empty = normalizeUsageRecord({provider: 'fixture', source: 'fixture', measurement: 'provider_reported', counters: {cost: {total: 0}}});
  assert.equal(empty.completeness, 'unavailable'); assert.equal(empty.measurement, 'unavailable'); assert.deepEqual(empty.tokens, {});
});


test('mocked invalid fractional counters cannot combine into a falsely complete integer total', () => {
  const fractionalClaude = claudeCodeWorker.parse([claudeMessage('m1', {...anthropic, input_tokens: 300.5, cache_creation_input_tokens: 1.5}), claudeResult], profile).usage![0]!;
  assert.equal(fractionalClaude.tokens.inputTokens, undefined); assert.equal(fractionalClaude.tokens.totalTokens, undefined); assert.equal(fractionalClaude.completeness, 'partial');
  const fractionalOpenCode = parseOpenCode([ocStep({input: 300.5, output: 32, reasoning: 8, cache: {read: 90, write: 1.5}})]).usage![0]!;
  assert.equal(fractionalOpenCode.tokens.inputTokens, undefined); assert.equal(fractionalOpenCode.tokens.totalTokens, undefined); assert.equal(fractionalOpenCode.completeness, 'partial');
});
