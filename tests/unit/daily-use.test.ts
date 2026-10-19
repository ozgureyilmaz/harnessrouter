import assert from 'node:assert/strict';
import test from 'node:test';
import {sanitizeMeasuredLinks} from '../../src/browser/measured-links.js';
import {addBrowserAllowlistHostname} from '../../src/config/allowlist-env.js';
import {applyStaticImageRoute} from '../../src/routing/image-route.js';
import {imageTaskFromBrowserRun} from '../../src/tasks/compose-image.js';
import type {HarnessManifest, HarnessResult, HarnessTask, Route} from '../../src/domain/types.js';
import type {EligibleRoute} from '../../src/registry/eligibility.js';

const imageTask: HarnessTask = {
  schemaVersion: '1.0', taskId: 'image', prompt: 'Draw', requirements: ['text_to_image', 'image'],
  acceptanceCriteria: [], desiredOutput: 'image', allowPaidExecution: true,
};

function route(id: string, harnessId: string): EligibleRoute {
  const manifest: HarnessManifest = {
    id: harnessId,
    kind: harnessId === 'native' ? 'host_defer' : 'custom_agent_harness',
    transport: harnessId === 'native' ? 'none' : 'in_process',
    enabled: true, permissions: [], capabilities: [], default_timeout_ms: 1000, routes: [],
  };
  const item: Route = {
    id, description: id, modalities: ['image'], eligible_requirements: ['image'],
    price_usd: null, price_status: 'not_applicable',
  };
  return {harness: manifest, route: item};
}

test('static image route keeps both profiles on auto', () => {
  const eligible = [route('fal-creative:image-fast', 'fal-creative'), route('fal-creative:image-quality', 'fal-creative'), route('native:defer', 'native')];
  const result = applyStaticImageRoute(eligible, 'auto', imageTask);
  assert.deepEqual(result.eligible.map(item => item.route.id), eligible.map(item => item.route.id));
  assert.deepEqual(result.excluded, []);
});

test('static fast image route drops the other profile and host fallback', () => {
  const eligible = [route('fal-creative:image-fast', 'fal-creative'), route('fal-creative:image-quality', 'fal-creative'), route('native:defer', 'native')];
  const result = applyStaticImageRoute(eligible, 'fast', imageTask);
  assert.deepEqual(result.eligible.map(item => item.route.id), ['fal-creative:image-fast']);
  assert.deepEqual(result.excluded.map(item => item.reason), ['static_image_route', 'static_image_route_skips_host_fallback']);
});

test('explicit high quality overrides a fast environment pin', () => {
  const eligible = [route('fal-creative:image-quality', 'fal-creative'), route('native:defer', 'native')];
  const result = applyStaticImageRoute(eligible, 'fast', {...imageTask, context: {creativeOptions: {quality: 'high'}}});
  assert.deepEqual(result.eligible.map(item => item.route.id), ['fal-creative:image-quality']);
});

test('measured links keep public https targets and drop everything else', () => {
  const links = sanitizeMeasuredLinks([
    {text: 'Learn more', href: 'https://www.iana.org/help/example-domains#section'},
    {text: 'Insecure', href: 'http://example.com/'},
    {text: 'Script', href: 'javascript:alert(1)'},
    {text: '', href: 'https://example.com/'},
  ]);
  assert.deepEqual(links, [{text: 'Learn more', href: 'https://www.iana.org/help/example-domains'}]);
});

test('allowlist edit adds one hostname without rewriting other env lines', () => {
  const next = addBrowserAllowlistHostname('OPENAI_API_KEY=secret\nBROWSER_ALLOWED_DOMAINS=example.com\n', 'developer.mozilla.org');
  assert.match(next, /OPENAI_API_KEY=secret/);
  assert.match(next, /BROWSER_ALLOWED_DOMAINS=example.com,developer.mozilla.org/);
  assert.equal(addBrowserAllowlistHostname(next, 'developer.mozilla.org'), next);
  assert.throws(() => addBrowserAllowlistHostname(next, 'localhost'));
});

test('compose builds an image task from browser observations', () => {
  const result: HarnessResult = {
    schemaVersion: '1.2', runId: 'browser-run', taskId: 'inspect', status: 'completed',
    selectedRouteId: 'pi-browser:configured', selectedHarnessId: 'pi-browser', artifacts: [],
    criterionResults: [], timing: {totalMs: 1}, cost: {status: 'unknown'},
    structuredOutput: {websiteObservations: {
      sourceUrl: 'https://example.com/', pageTitle: 'Example', visualStyle: {palette: {}}, screenshotPath: '/tmp/shot.png',
      links: [{text: 'Learn more', href: 'https://www.iana.org/help/example-domains'}],
    }},
  };
  const task = imageTaskFromBrowserRun('browser-run', result, 'fast');
  assert.equal(task.parentRunId, 'browser-run');
  assert.equal(task.context?.creativeOptions && (task.context.creativeOptions as {quality: string}).quality, 'fast');
  assert.equal((task.context?.websiteObservations as {links: {href: string}[]}).links[0]?.href, 'https://www.iana.org/help/example-domains');
});
