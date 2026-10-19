import type {HarnessResult, HarnessTask} from '../domain/types.js';
import type {ImageRoutePreference} from '../routing/image-route.js';

/** Build the second route_task payload from a completed browser HarnessResult. */
export function imageTaskFromBrowserRun(runId: string, result: HarnessResult, preference: ImageRoutePreference = 'auto'): HarnessTask {
  if (result.status !== 'completed') throw new Error('Browser run did not complete.');
  const observations = result.structuredOutput?.websiteObservations;
  if (!observations || typeof observations !== 'object') throw new Error('Browser run has no websiteObservations.');
  const record = observations as Record<string, unknown>;
  if (typeof record.sourceUrl !== 'string' || typeof record.pageTitle !== 'string' || !record.visualStyle || typeof record.screenshotPath !== 'string') {
    throw new Error('Browser observations are missing sourceUrl, pageTitle, visualStyle, or screenshotPath.');
  }
  const quality = preference === 'fast' ? 'fast' : preference === 'quality' ? 'high' : 'balanced';
  return {
    schemaVersion: '1.0',
    taskId: `image-from-${runId}`,
    parentRunId: runId,
    prompt: 'Create a 16:9 illustration matching the measured website style in the supplied observations. Do not reproduce page text or logos.',
    requirements: ['text_to_image', 'image'],
    requiredCapabilities: ['media.text_to_image'],
    acceptanceCriteria: [
      'Actual fal request ID',
      'Decoded 16:9 image',
      'Observed website style consumed by planner',
    ],
    desiredOutput: 'image',
    maxCostUsd: 0.25,
    allowPaidExecution: true,
    timeoutMs: 180000,
    context: {
      websiteObservations: observations,
      creativeOptions: {
        aspectRatio: '16:9',
        quality,
        style: 'minimal geometric editorial illustration',
        seed: 42,
      },
    },
  };
}
