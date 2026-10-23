/** Only local trusted configuration may grant access to source workspaces. */
export interface WorkspacePolicy {
  roots: string[];
  maxFiles?: number;
  maxBytes?: number;
  /** Extra snapshot globs. `*` is one segment; `**` crosses segments. */
  exclude?: string[];
  /**
   * Paths to keep even when a secret rule matches.
   * A `.git` path is never returned to the snapshot, including when it matches `include`.
   */
  include?: string[];
}
export interface WorkspaceRequest { root: string; mode: 'read-only' | 'patch'; includeUntracked?: string[] }
export interface WorkspaceSnapshot {
  root: string;
  baselineFingerprint: string;
  sourceRoot: string;
  mode: 'read-only' | 'patch';
  /** How many tracked paths the snapshot left out. */
  excludedCount: number;
  /** Alphabetical sample of excluded paths, capped at 50. The count is the full total. */
  excludedPaths: string[];
}
export interface WorkspacePatch {
  path: string;
  changedFiles: string[];
  baselineFingerprint: string;
  sha256: string;
}
