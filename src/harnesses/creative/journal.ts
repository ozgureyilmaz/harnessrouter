import {randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {RouterError} from '../../domain/errors.js';

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  modelId: z.enum(['fal-ai/flux/schnell', 'fal-ai/flux-2']),
  phase: z.enum(['claiming', 'prepared', 'submitting', 'submitted', 'ambiguous', 'completed', 'failed']),
  expectedAspectRatio: z.number().positive().max(4),
  expectedWidth: z.number().int().positive(),
  expectedHeight: z.number().int().positive(),
  estimatedCostUsd: z.number().nonnegative(),
  parentRunId: z.string().min(1).optional(),
  observationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceUrl: z.string().url().optional(),
  reservationId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  artifactPath: z.string().regex(/^fal-image\.(png|jpg|webp)$/).optional(),
  artifactUrl: z.string().url().optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  summary: z.string().optional(),
}).strict();

export type CreativeRunState = z.infer<typeof stateSchema>;

const STATE_FILENAME = '.fal-creative-state.json';

export type ClaimResult =
  | {kind: 'fresh'; state: CreativeRunState}
  | {kind: 'resume'; state: CreativeRunState}
  | {kind: 'cached'; state: CreativeRunState}
  | {kind: 'blocked'; code: string; message: string; state?: CreativeRunState};

export async function claimCreativeRun(directory: string, initial: Omit<CreativeRunState, 'phase'>): Promise<ClaimResult> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const statePath = join(directory, STATE_FILENAME);
  const freshState: CreativeRunState = {...initial, phase: 'claiming'};

  try {
    const handle = await open(statePath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(freshState, null, 2) + '\n');
    } finally {
      await handle.close();
    }
    return {kind: 'fresh', state: freshState};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new RouterError('creative_state_write_failed', 'Could not create the fal submission journal.');
    }
  }

  let state: CreativeRunState;
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid state shape');
    state = parsed.data;
  } catch {
    return {kind: 'blocked', code: 'reconciliation_required', message: 'The saved fal submission state is unreadable; no new request was sent.'};
  }

  if (state.runId !== initial.runId || state.inputFingerprint !== initial.inputFingerprint || state.modelId !== initial.modelId) {
    return {kind: 'blocked', code: 'run_id_conflict', message: 'This run ID is already bound to a different fal request.'};
  }
  if (state.phase === 'completed') return {kind: 'cached', state};
  if (state.phase === 'submitted' && state.requestId && state.reservationId) return {kind: 'resume', state};
  return {
    kind: 'blocked',
    code: 'reconciliation_required',
    message: 'A prior fal submission may exist for this run. The harness will not submit it again.',
    state,
  };
}

export async function saveCreativeRunState(directory: string, state: CreativeRunState): Promise<void> {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) throw new RouterError('creative_state_invalid', 'The fal submission journal failed validation.');
  const target = join(directory, STATE_FILENAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(parsed.data, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await rename(temporary, target);
}
