import {z} from 'zod';
import {RouterError} from '../domain/errors.js';
import type {WorkerProfile} from './types.js';

export type RoutePermission = 'read-only' | 'patch';
export const WORKSPACE_TOOL_NAMES = ['list_files', 'read_file', 'write_file'] as const;
export type WorkspaceToolName = typeof WORKSPACE_TOOL_NAMES[number];

/** A named route above a worker profile. Trusted local configuration only. */
export interface RouteProfile {
  id: string;
  harness: string;
  model?: string;
  systemInstructions?: string;
  enabledTools?: WorkspaceToolName[];
  /** Names only. This field is not forwarded to a worker. */
  allowedMcpServers: string[];
  permissions: RoutePermission;
  priority?: number;
}

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const schema = z.array(z.object({
  id: z.string().regex(idPattern),
  harness: z.string().regex(idPattern),
  model: z.string().min(1).max(100).regex(/^[^\s\x00-\x1f]+$/).optional(),
  systemInstructions: z.string().min(1).max(400).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)).optional(),
  enabledTools: z.array(z.enum(WORKSPACE_TOOL_NAMES)).max(WORKSPACE_TOOL_NAMES.length).optional(),
  allowedMcpServers: z.array(z.string().regex(idPattern)).max(8).optional(),
  permissions: z.enum(['read-only', 'patch']),
  priority: z.number().int().min(0).max(1000).optional(),
}).strict()).max(32);

export function defaultEnabledTools(permissions: RoutePermission): WorkspaceToolName[] {
  return permissions === 'patch' ? ['list_files', 'read_file', 'write_file'] : ['list_files', 'read_file'];
}

export function routeIdFor(profile: {harness: string; id: string}): string {
  return `${profile.harness}:${profile.id}`;
}

/** preferredRouteId may be the route id or the bare profile id. */
export function preferenceSelectsRoute(preferred: string | undefined, routeId: string, profiles: readonly RouteProfile[] = []): boolean {
  if (!preferred) return true;
  if (preferred === routeId) return true;
  return profiles.some(profile => profile.id === preferred && routeIdFor(profile) === routeId);
}

export function routeProfileDescription(worker: WorkerProfile, profile: RouteProfile): string {
  const model = profile.model ?? worker.model;
  const instructions = profile.systemInstructions?.replace(/\s+/g, ' ').trim();
  const summary = instructions ? instructions.slice(0, 180) : profile.permissions === 'read-only' ? 'Read-only profile.' : 'Can return a patch.';
  const tools = (profile.enabledTools ?? defaultEnabledTools(profile.permissions)).join(', ');
  const text = `${profile.id}: ${worker.adapter} model ${model}; ${profile.permissions}; tools ${tools}. ${summary}`;
  return text.length > 500 ? text.slice(0, 500) : text;
}

export function parseRouteProfiles(value: unknown, workers: readonly WorkerProfile[]): RouteProfile[] {
  const parsed = schema.safeParse(value ?? []);
  if (!parsed.success) throw new RouterError('invalid_config', 'Invalid route profiles: ' + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const ids = new Set<string>();
  const workerById = new Map(workers.map(worker => [worker.id, worker]));
  return parsed.data.map(profile => {
    if (profile.id === 'configured' || ids.has(profile.id)) throw new RouterError('invalid_config', 'Route profile ids must be unique and cannot use the configured route name');
    ids.add(profile.id);
    const worker = workerById.get(profile.harness);
    if (!worker) throw new RouterError('invalid_config', `Route profile ${profile.id} must name a configured worker profile`);
    if (profile.model && profile.model !== worker.model && !worker.allowedModels?.includes(profile.model)) {
      throw new RouterError('invalid_config', `Route profile ${profile.id} model is outside the worker model allowlist`);
    }
    if (profile.enabledTools && new Set(profile.enabledTools).size !== profile.enabledTools.length) {
      throw new RouterError('invalid_config', `Route profile ${profile.id} repeats a workspace tool`);
    }
    if (profile.permissions === 'read-only' && profile.enabledTools?.includes('write_file')) {
      throw new RouterError('invalid_config', `Route profile ${profile.id} cannot enable write_file with read-only permission`);
    }
    const servers = profile.allowedMcpServers ?? [];
    if (new Set(servers).size !== servers.length || servers.includes('harnessrouter')) {
      throw new RouterError('invalid_config', `Route profile ${profile.id} has a duplicate or recursive MCP server name`);
    }
    return {...profile, allowedMcpServers: servers};
  });
}
