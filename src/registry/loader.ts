import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {validateRegistry} from '../domain/schemas.js';
import {RouterError} from '../domain/errors.js';
import type {Registry} from '../domain/types.js';
import type {WorkerProfile} from '../workers/types.js';
import type {RouteProfile} from '../workers/route-profile.js';
import {validateWorkerManifest} from '../workers/registry.js';

const SAFE_NATIVE_FALLBACK_REQUIREMENTS = new Set([
  'browser', 'screenshot', 'public_site_research', 'image', 'text_to_image',
]);

/** Load and validate a JSON/YAML harness registry from disk. */
export async function loadRegistry(path: string, profiles: readonly WorkerProfile[] = []): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new RouterError('registry_unavailable', 'Unable to read the configured harness registry');
  }

  const extension = extname(path).toLowerCase();
  let value: unknown;
  try {
    if (extension === '.json') value = JSON.parse(text);
    else if (extension === '.yaml' || extension === '.yml') {
      value = parseYaml(text, {uniqueKeys: true, maxAliasCount: 0});
    } else {
      throw new RouterError('registry_format_unsupported', 'Registry must use .json, .yaml, or .yml');
    }
  } catch (error) {
    if (error instanceof RouterError) throw error;
    throw new RouterError('registry_invalid', 'Registry is not valid JSON or YAML');
  }

  validateRegistry(value);
  validateSupportedRegistry(value, profiles);
  return value;
}

/** Validate configured bindings before route filtering; task input cannot register adapters. */
export function validateSupportedRegistry(registry: Registry, profiles: readonly WorkerProfile[] = [], routeProfiles: readonly RouteProfile[] = []): void {
  assertUniqueIds(registry);
  const bindings: Record<string, {kind: string; transport: string; routeModels: Record<string, string | null>}> = {
    'pi-browser': {
      kind: 'external_agent_runtime', transport: 'pi_rpc',
      routeModels: {'pi-browser:configured': null},
    },
    'fal-creative': {
      kind: 'custom_agent_harness', transport: 'in_process',
      routeModels: {
        'fal-creative:image-fast': 'fal-ai/flux/schnell',
        'fal-creative:image-quality': 'fal-ai/flux-2',
      },
    },
    native: {kind: 'host_defer', transport: 'none', routeModels: {'native:defer': null}},
  };

  for (const harness of registry.harnesses) {
    const profile = profiles.find(profile => profile.id === harness.id);
    if(profile){validateWorkerManifest(harness,profile,routeProfiles);continue;}
    const binding = bindings[harness.id];
    if (!binding) throw new RouterError('registry_unsupported', `Harness is outside the registered adapter set: ${harness.id}`);
    if (harness.kind !== binding.kind || harness.transport !== binding.transport) {
      throw new RouterError('registry_unsupported', `Harness kind or transport does not match the adapter: ${harness.id}`);
    }
    for (const route of harness.routes) {
      if (route.description.length > 500) {
        throw new RouterError('registry_unsupported', `Route description exceeds the description limit: ${route.id}`);
      }
      if (!route.id.startsWith(`${harness.id}:`)) {
        throw new RouterError('registry_unsupported', `Route ID is not bound to its harness: ${route.id}`);
      }
      if (!Object.hasOwn(binding.routeModels, route.id)) {
        throw new RouterError('registry_unsupported', `Route is outside the configured profiles: ${route.id}`);
      }
      if (route.fallback_requirements !== undefined) {
        if (harness.id !== 'native') {
          throw new RouterError('registry_unsupported', 'Only the native host-defer route may declare control fallback requirements');
        }
        const normalizedFallback = route.fallback_requirements.map(requirement => requirement.trim().toLowerCase());
        if (normalizedFallback.some(requirement => !SAFE_NATIVE_FALLBACK_REQUIREMENTS.has(requirement))
          || new Set(normalizedFallback).size !== normalizedFallback.length) {
          throw new RouterError('registry_unsupported', 'Native fallback requirements exceed the safe MVP allowlist');
        }
      }
      if (harness.id === 'pi-browser') {
        if (route.agent_model_profile !== 'configured' || route.generation_model_id != null) {
          throw new RouterError('registry_unsupported', 'Pi Browser supports only the configured agent model profile');
        }
      } else if (harness.id === 'fal-creative') {
        if (route.generation_model_id !== binding.routeModels[route.id] || route.agent_model_profile != null) {
          throw new RouterError('registry_unsupported', `fal model binding does not match its configured route: ${route.id}`);
        }
      } else if (route.agent_model_profile != null || route.generation_model_id != null) {
        throw new RouterError('registry_unsupported', 'Native defer routes cannot bind an execution model');
      }
    }
  }
}

function assertUniqueIds(registry: Registry): void {
  const harnessIds = new Set<string>();
  const routeIds = new Set<string>();
  for (const harness of registry.harnesses) {
    if (harnessIds.has(harness.id)) {
      throw new RouterError('registry_invalid', `Duplicate harness ID: ${harness.id}`);
    }
    harnessIds.add(harness.id);
    for (const route of harness.routes) {
      if (routeIds.has(route.id)) {
        throw new RouterError('registry_invalid', `Duplicate route ID: ${route.id}`);
      }
      routeIds.add(route.id);
    }
  }
}
