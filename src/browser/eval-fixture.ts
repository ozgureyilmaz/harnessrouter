import {createHash} from 'node:crypto';

export const EVALUATION_FIXTURE_ORIGIN = 'https://example.com';
export const EVALUATION_FIXTURE_PATH_PREFIX = '/__harness_eval__/';
export const MAX_EVALUATION_FIXTURE_BYTES = 100 * 1024;

export interface EvaluationFixture {
  id: string;
  url: string;
  html: string;
}

export interface EvaluationFixtureRequest {
  url: string;
  resourceType: string;
  isNavigationRequest: boolean;
  isMainFrame: boolean;
}

export interface EvaluationFixtureResponse {
  status: 200;
  contentType: 'text/html; charset=utf-8';
  body: string;
}

/** Validate host-owned fixture data before it enters the isolated browser process. */
export function parseEvaluationFixture(value: unknown): EvaluationFixture {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'url', 'html'].includes(key)) ||
      typeof value.id !== 'string' || typeof value.url !== 'string' || typeof value.html !== 'string') {
    throw new Error('Evaluation fixture must contain only string id, url, and html fields.');
  }
  if (!/^[a-z0-9-]+$/.test(value.id) || value.id.length > 80) {
    throw new Error('Evaluation fixture id must use lowercase letters, digits, and hyphens.');
  }
  const expectedUrl = `${EVALUATION_FIXTURE_ORIGIN}${EVALUATION_FIXTURE_PATH_PREFIX}${value.id}`;
  if (value.url !== expectedUrl) {
    throw new Error('Evaluation fixture URL must exactly match its canonical host-owned URL.');
  }
  if (Buffer.byteLength(value.html, 'utf8') > MAX_EVALUATION_FIXTURE_BYTES) {
    throw new Error('Evaluation fixture HTML exceeds 100 KiB.');
  }
  assertNoExternalFixtureResources(value.html);
  return {id: value.id, url: value.url, html: value.html};
}

export function evaluationFixtureHash(fixture: EvaluationFixture): string {
  return createHash('sha256').update(fixture.html, 'utf8').digest('hex');
}

/** Return the one permitted local response; every other request must be aborted. */
export function evaluationFixtureResponse(
  fixture: EvaluationFixture,
  request: EvaluationFixtureRequest,
  alreadyServed: boolean,
): EvaluationFixtureResponse | undefined {
  if (alreadyServed || request.url !== fixture.url || request.resourceType !== 'document' ||
      !request.isNavigationRequest || !request.isMainFrame) return undefined;
  return {status: 200, contentType: 'text/html; charset=utf-8', body: fixture.html};
}

function assertNoExternalFixtureResources(html: string): void {
  // Evaluation fixtures are static evidence pages. Avoid active content and every
  // resource-loading element so the browser never needs a second network request.
  if (/<\s*(?:script|iframe|frame|object|embed|form|base|portal|audio|video|source|track|link|image|use)\b/i.test(html) ||
      /\son[a-z][\w:-]*\s*=/i.test(html) || /\ssrc(?:set)?\s*=/i.test(html) ||
      /\s(?:poster|background)\s*=/i.test(html) || /\s(?:data|action|formaction)\s*=/i.test(html) ||
      /<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(html) || /@import\b|url\s*\(/i.test(html)) {
    throw new Error('Evaluation fixtures cannot contain active content or external resource references.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
