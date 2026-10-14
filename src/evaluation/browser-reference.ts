import {randomUUID} from 'node:crypto';
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BrowserSession} from '../browser/session.js';
import {evaluationFixtureHash, parseEvaluationFixture, type EvaluationFixture} from '../browser/eval-fixture.js';
import {assertAllowedUrl, validatePublicUrl} from '../browser/policy.js';

export interface BrowserReference {
  url: string;
  title: string;
  text: string;
  textTruncated: boolean;
  visualStyle?: {
    viewport: {width: number; height: number};
    palette: {pageBackground: string; bodyText: string; heading: string | null; link: string | null};
    typography: {
      bodyFontFamily: string;
      bodyFontSize: string;
      bodyLineHeight: string;
      headingFontFamily: string | null;
      headingFontSize: string | null;
      headingFontWeight: string | null;
    };
    layout: {mainContentBox: {x: number; y: number; width: number; height: number} | null};
  };
  screenshotPath: string;
  sha256: string;
  capturedAt: string;
  environment: 'controlled' | 'public';
  fixtureId?: string;
  fixtureHash?: string;
}

export async function captureBrowserReference(options: {
  url: string;
  allowedDomains: readonly string[];
  fixture?: EvaluationFixture;
  directory: string;
  chromeChannel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BrowserReference> {
  const fixture = options.fixture ? parseEvaluationFixture(options.fixture) : undefined;
  const allowedDomains = [...options.allowedDomains];
  if (fixture) {
    if (options.url !== fixture.url || !allowedDomains.map((domain) => domain.toLowerCase()).includes('example.com')) {
      throw new Error('Controlled browser reference must use its exact host-owned fixture URL and allowlist.');
    }
  } else {
    await validatePublicUrl(options.url, allowedDomains);
  }
  assertAllowedUrl(options.url, allowedDomains);

  await mkdir(options.directory, {recursive: true, mode: 0o700});
  const directory = await realpath(options.directory);
  const id = randomUUID();
  const screenshotPath = join(directory, `browser-reference-${id}.png`);
  const session = new BrowserSession({
    allowedDomains,
    ...(options.chromeChannel ? {chromeChannel: options.chromeChannel} : {}),
    ...(options.timeoutMs ? {operationTimeoutMs: options.timeoutMs} : {}),
    ...(fixture ? {evaluationFixture: fixture} : {}),
  });

  try {
    await session.navigate(options.url, options.signal);
    const observation = await session.captureOracleReference(screenshotPath, options.signal);
    const image = await readFile(screenshotPath);
    const reference: BrowserReference = {
      url: observation.url,
      title: observation.title,
      text: observation.text,
      textTruncated: observation.textTruncated,
      visualStyle: observation.visualStyle,
      screenshotPath,
      sha256: createHash('sha256').update(image).digest('hex'),
      capturedAt: new Date().toISOString(),
      environment: fixture ? 'controlled' : 'public',
      ...(fixture ? {fixtureId: fixture.id, fixtureHash: evaluationFixtureHash(fixture)} : {}),
    };
    await writeFile(join(directory, `browser-reference-${id}.json`), `${JSON.stringify({schemaVersion: '1.0', ...reference}, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    return reference;
  } finally {
    await session.close();
  }
}
