import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import browserExtension from '../../src/browser/pi-extension.js';

interface CapturedTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute(...args: unknown[]): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
}

test('controlled Pi extension exposes only fixed public-browser tools', async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'harnessrouter-pi-tools-'));
  const previous = {
    domains: process.env.HARNESSROUTER_ALLOWED_DOMAINS,
    artifactsDir: process.env.HARNESSROUTER_ARTIFACTS_DIR,
    runId: process.env.HARNESSROUTER_RUN_ID,
    initialUrl: process.env.HARNESSROUTER_INITIAL_URL,
  };
  process.env.HARNESSROUTER_ALLOWED_DOMAINS = JSON.stringify(['example.com']);
  process.env.HARNESSROUTER_ARTIFACTS_DIR = artifactsDir;
  process.env.HARNESSROUTER_RUN_ID = 'test-run';
  process.env.HARNESSROUTER_INITIAL_URL = 'https://example.com/';
  t.after(async () => {
    if (previous.domains === undefined) delete process.env.HARNESSROUTER_ALLOWED_DOMAINS;
    else process.env.HARNESSROUTER_ALLOWED_DOMAINS = previous.domains;
    if (previous.artifactsDir === undefined) delete process.env.HARNESSROUTER_ARTIFACTS_DIR;
    else process.env.HARNESSROUTER_ARTIFACTS_DIR = previous.artifactsDir;
    if (previous.runId === undefined) delete process.env.HARNESSROUTER_RUN_ID;
    else process.env.HARNESSROUTER_RUN_ID = previous.runId;
    if (previous.initialUrl === undefined) delete process.env.HARNESSROUTER_INITIAL_URL;
    else process.env.HARNESSROUTER_INITIAL_URL = previous.initialUrl;
    await rm(artifactsDir, { recursive: true, force: true });
  });

  const tools = new Map<string, CapturedTool>();
  let shutdown: (() => Promise<void>) | undefined;
  const fakePi = {
    registerTool(tool: CapturedTool) { tools.set(tool.name, tool); },
    on(event: string, handler: () => Promise<void>) {
      if (event === 'session_shutdown') shutdown = handler;
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  browserExtension(fakePi);

  assert.deepEqual([...tools.keys()].sort(), ['browser_extract', 'browser_open', 'browser_screenshot']);
  const schemaText = JSON.stringify([...tools.values()].map((tool) => tool.parameters));
  assert.deepEqual(Object.keys(tools.get('browser_open')!.parameters.properties ?? {}), []);
  assert.doesNotMatch(schemaText, /evaluate|javascript|upload|shell/i);

  const noPageExtract = await tools.get('browser_extract')!.execute('call-1', {}, undefined, undefined, undefined);
  assert.equal(noPageExtract.isError, true);
  const noPageScreenshot = await tools.get('browser_screenshot')!.execute('call-2', {}, undefined, undefined, undefined);
  assert.equal(noPageScreenshot.isError, true);
  await shutdown?.();
});
