import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadRegistry} from '../../src/registry/loader.js';

const registry = {
  version: 1,
  harnesses: [{
    id: 'native', kind: 'host_defer', transport: 'none', enabled: true,
    permissions: [], capabilities: ['coding', 'host_owned_tasks'], default_timeout_ms: 0,
    routes: [{
      id: 'native:defer', description: 'Return work to host', modalities: ['text'],
      eligible_requirements: ['coding', 'unsupported_fallback'], price_usd: null,
      price_status: 'not_applicable', enabled: true,
    }],
  }],
};

test('registry loader parses YAML and validates its manifest', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harnessrouter-registry-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'registry.yaml');
  await writeFile(path, [
    'version: 1', 'harnesses:', '  - id: native', '    kind: host_defer', '    transport: none',
    '    enabled: true', '    permissions: []', '    capabilities: [coding, host_owned_tasks]',
    '    default_timeout_ms: 0', '    routes:', '      - id: native:defer', '        description: Return work to host',
    '        modalities: [text]', '        eligible_requirements: [coding, unsupported_fallback]',
    '        price_usd: null', '        price_status: not_applicable', '        enabled: true', '',
  ].join('\n'));
  assert.deepEqual(await loadRegistry(path), registry);
});

test('registry loader rejects schema-invalid and duplicate route IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harnessrouter-registry-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'registry.json');

  await writeFile(path, JSON.stringify({...registry, version: 2}));
  await assert.rejects(loadRegistry(path), {code: 'schema_invalid'});

  const duplicate = structuredClone(registry);
  duplicate.harnesses.push({...duplicate.harnesses[0], id: 'native-copy'});
  await writeFile(path, JSON.stringify(duplicate));
  await assert.rejects(loadRegistry(path), {code: 'registry_invalid'});
});

test('registry loader rejects malformed YAML and unsupported extensions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harnessrouter-registry-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const yaml = join(directory, 'registry.yml');
  await writeFile(yaml, 'version: [unterminated');
  await assert.rejects(loadRegistry(yaml), {code: 'registry_invalid'});
  const unknown = join(directory, 'registry.toml');
  await writeFile(unknown, 'version = 1');
  await assert.rejects(loadRegistry(unknown), {code: 'registry_format_unsupported'});
});
