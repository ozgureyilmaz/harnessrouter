import {Ajv2020} from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PROJECT_ROOT} from '../config.js';
import type {HarnessTask,HarnessResult,Registry,DecisionTrace,BenchmarkRunRecord} from './types.js';
import {RouterError} from './errors.js';
const ajv = new Ajv2020({allErrors: true, strict: true});
export const rawSchemas = Object.fromEntries(['task','result','harness-manifest','decision-trace','benchmark-run'].map(name=>[
  name, JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'contracts', `${name}.schema.json`), 'utf8'))
]));
const validators = Object.fromEntries(Object.entries(rawSchemas).map(([key,value])=>[key,ajv.compile(value)]));
function assertSchema(name: string, value: unknown): void {
  if (!validators[name](value)) throw new RouterError('schema_invalid', `${name}: ${ajv.errorsText(validators[name].errors)}`);
}
export function validateTask(value: unknown): asserts value is HarnessTask {assertSchema('task',value);}
export function validateResult(value: unknown): asserts value is HarnessResult {assertSchema('result',value);}
export function validateRegistry(value: unknown): asserts value is Registry {assertSchema('harness-manifest',value);}
export function validateTrace(value: unknown): asserts value is DecisionTrace {assertSchema('decision-trace',value);}
export function validateBenchmarkRun(value: unknown): asserts value is BenchmarkRunRecord {assertSchema('benchmark-run',value);}
