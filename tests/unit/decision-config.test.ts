import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config.js';

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'harnessrouter-decision-config-'));
  try { await fn(cwd); } finally { await rm(cwd, {recursive: true, force: true}); }
}
function envFor(cwd: string, vars: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {XDG_CONFIG_HOME: join(cwd, 'user-config'), XDG_STATE_HOME: join(cwd, 'state'), ...vars};
}


test('default selector is active OpenAI Decisions configuration with safe execution gates', async () => withCwd(async cwd => {
  const config = loadConfig({cwd, env: envFor(cwd)});
  assert.equal(config.selector, 'decisions');
  assert.equal(config.decisionProvider, 'openai');
  assert.equal(config.decisionModel, 'gpt-6-luna');
  assert.equal(config.decisionReserveUsd, 0.01);
  assert.equal(config.decisionTimeoutMs, 10000);
  assert.equal(config.dryRun, true);
  assert.equal(config.allowPaid, false);
  assert.equal(config.allowExecution, false);
  assert.equal(config.apiKey, undefined);
}));

test('explicit local selector remains an opt-out', async () => withCwd(async cwd => {
  const config = loadConfig({cwd, env: envFor(cwd, {ROUTER_SELECTOR: 'local', MAX_COST_USD_PER_TASK: '0'})});
  assert.equal(config.selector, 'local');
  assert.equal(config.decisionProvider, 'openai');
  assert.equal(config.perTaskUsd, 0);
  assert.equal(config.decisionReserveUsd, 0.01);
}));

test('zero task cap disables the paid decision reservation without invalidating config', async () => withCwd(async cwd => {
  const config = loadConfig({cwd, env: envFor(cwd, {ROUTER_SELECTOR: 'decisions', MAX_COST_USD_PER_TASK: '0'})});
  assert.equal(config.selector, 'decisions');
  assert.equal(config.decisionReserveUsd, 0.01);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_SELECTOR: 'local', MAX_COST_USD_PER_TASK: '0', ROUTER_DECISION_RESERVE_USD: '0'})}), /must be positive and finite/);
}));

test('TypeSafe is independent, accepts its documented model family and key alias', async () => withCwd(async cwd => {
  const config = loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'jev', TYPESAFE_API_KEY: 'typesafe-secret', DECISIONS_MODEL: 'jev-1.13.0'})});
  assert.equal(config.decisionProvider, 'jev');
  assert.equal(config.decisionModel, 'jev-1.13.0');
  assert.equal(config.jevApiKey, 'typesafe-secret');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.decisionReserveUsd, 0.01);
  const alias = loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'jev', JEV_API_KEY: 'alias-secret'})});
  assert.equal(alias.jevApiKey, 'alias-secret');
  const same = loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'jev', TYPESAFE_API_KEY: 'same', JEV_API_KEY: 'same'})});
  assert.equal(same.jevApiKey, 'same');
}));

test('ambiguous hosted credentials and cross-provider model names fail closed', async () => withCwd(async cwd => {
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'jev', TYPESAFE_API_KEY: 'one', JEV_API_KEY: 'two'})}), /both set to different values/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'jev', DECISIONS_MODEL: 'gpt-6-luna'})}), /jev-\*/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'openai', DECISIONS_MODEL: 'gpt-6-astra'})}), /pinned to gpt-6-luna/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'unknown'})}), /must be openai, jev, or ollaya/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'ollaya', DECISIONS_MODEL: 'laya model'})}), /without whitespace/);
}));

test('decision timeout and paid decision reserve are finite and bounded by task budget', async () => withCwd(async cwd => {
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_TIMEOUT_MS: '1.5'})}), /positive 32-bit timer value/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_TIMEOUT_MS: '0'})}), /positive 32-bit timer value/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_TIMEOUT_MS: '2147483648'})}), /positive 32-bit timer value/);
  assert.equal(loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_TIMEOUT_MS: '2147483647'})}).decisionTimeoutMs, 2147483647);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {MAX_COST_USD_PER_TASK: '0.01', ROUTER_DECISION_RESERVE_USD: '0.02'})}), /no greater than MAX_COST_USD_PER_TASK/);
  assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_RESERVE_USD: 'Infinity'})}), /finite and nonnegative/);
  assert.equal(loadConfig({cwd, env: envFor(cwd, {MAX_COST_USD_PER_TASK: '0.01', ROUTER_DECISION_RESERVE_USD: '0.01'})}).decisionReserveUsd, 0.01);
}));

test('Ollaya is local-only, distinct-key configured and does not reserve hosted spend', async () => withCwd(async cwd => {
  const config = loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'ollaya', ROUTER_OLLAYA_BASE_URL: 'http://127.0.0.1:11435', OLLAYA_API_KEY: 'local-key', OPENAI_API_KEY: 'hosted-key', ROUTER_DECISION_RESERVE_USD: '0.5'})});
  assert.equal(config.decisionProvider, 'ollaya');
  assert.equal(config.decisionModel, 'laya:typed-decisions');
  assert.equal(config.ollayaBaseUrl, 'http://127.0.0.1:11435');
  assert.equal(config.ollayaApiKey, 'local-key');
  assert.equal(config.apiKey, 'hosted-key');
  assert.equal(config.jevApiKey, undefined);
  assert.equal(config.decisionReserveUsd, 0);
}));

test('Ollaya defaults to the local System One origin', async () => withCwd(async cwd => {
  const config = loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'ollaya'})});
  assert.equal(config.ollayaBaseUrl, 'http://127.0.0.1:11435');
}));

test('Ollaya URL rejects remote, non-origin and credential-bearing URLs', async () => withCwd(async cwd => {
  for (const url of [
    'https://ollaya.example/api',
    'http://localhost:11435/v1/decisions',
    'http://localhost:11435/?secret=1',
    'http://localhost:11435?',
    'http://localhost:11435#',
    'http://user:pass@localhost:11435',
    'file:///tmp/ollaya',
    'http://192.168.1.4:11435',
    'http://127.0.0.2:11435',
  ]) assert.throws(() => loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'ollaya', ROUTER_OLLAYA_BASE_URL: url})}), /loopback/);
  assert.equal(loadConfig({cwd, env: envFor(cwd, {ROUTER_DECISION_PROVIDER: 'ollaya', ROUTER_OLLAYA_BASE_URL: 'http://[::1]:11435'})}).ollayaBaseUrl, 'http://[::1]:11435');
}));

test('decision settings can be stored in explicit JSON but credentials cannot', async () => withCwd(async cwd => {
  const configPath = join(cwd, 'router.json');
  await writeFile(configPath, JSON.stringify({selector: 'decisions', decisionProvider: 'ollaya', decisionModel: 'laya:typed-decisions', decisionTimeoutMs: 1500, decisionReserveUsd: 4, ollayaBaseUrl: 'http://localhost:11435'}));
  const config = loadConfig({cwd, configPath, env: envFor(cwd)});
  assert.equal(config.decisionProvider, 'ollaya');
  assert.equal(config.decisionTimeoutMs, 1500);
  assert.equal(config.decisionReserveUsd, 0);
  assert.equal(config.ollayaBaseUrl, 'http://localhost:11435');
  await writeFile(configPath, JSON.stringify({decisionProvider: 'jev', TYPESAFE_API_KEY: 'secret'}));
  assert.throws(() => loadConfig({cwd, configPath, env: envFor(cwd)}), /supported settings and no credentials/);
}));
