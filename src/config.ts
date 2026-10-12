import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'dotenv';
import {RouterError} from './domain/errors.js';
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig() {
  const env = {...process.env};
  const path = resolve(PROJECT_ROOT, '.env');
  if (existsSync(path)) Object.assign(env, parse(readFileSync(path)));
  // Provider clients and the trace redactor see only documented credential names.
  for (const key of ['OPENAI_API_KEY','FAL_KEY']) if (env[key]) process.env[key]=env[key];
  const number = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new RouterError('invalid_config', `${key} must be a finite nonnegative number`);
    return value;
  };
  return {
    root: PROJECT_ROOT, apiKey: env.OPENAI_API_KEY || undefined, falKey: env.FAL_KEY || undefined,
    allowPaid: env.ROUTER_ALLOW_PAID_RUNS === 'true', dryRun: env.ROUTER_DRY_RUN !== 'false',
    perTaskUsd: number('MAX_COST_USD_PER_TASK', .25), sessionUsd: number('MAX_COST_USD_PER_SESSION', 0),
    decisionModel: env.DECISIONS_MODEL ?? 'gpt-6-luna', decisionTimeoutMs: number('ROUTER_DECISION_TIMEOUT_MS', 10000),
    piTaskTimeoutMs: number('PI_TASK_TIMEOUT_MS',120000), falTaskTimeoutMs: number('FAL_TASK_TIMEOUT_MS',180000),
    allowedDomains: (env.BROWSER_ALLOWED_DOMAINS ?? 'example.com').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),
    artifactsDir: resolve(PROJECT_ROOT, env.ARTIFACTS_DIR ?? 'artifacts'),
    registryPath: resolve(PROJECT_ROOT, 'config/harness-registry.yaml'),
  };
}
export type RouterConfig = ReturnType<typeof loadConfig>;
