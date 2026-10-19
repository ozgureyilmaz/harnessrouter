/** Only local trusted configuration may grant access to source workspaces. */
export interface WorkspacePolicy { roots: string[]; maxFiles?: number; maxBytes?: number }
export interface WorkspaceRequest { root: string; mode: 'read-only' | 'patch'; includeUntracked?: string[] }
export interface WorkspaceSnapshot {
  root: string;
  baselineFingerprint: string;
  sourceRoot: string;
  mode: 'read-only' | 'patch';
}
export interface WorkspacePatch {
  path: string;
  changedFiles: string[];
  baselineFingerprint: string;
  sha256: string;
}
