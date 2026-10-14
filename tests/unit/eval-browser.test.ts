import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluationFixtureHash,
  evaluationFixtureResponse,
  parseEvaluationFixture,
  type EvaluationFixture,
} from '../../src/browser/eval-fixture.js';

const fixture: EvaluationFixture = {
  id: 'case-alpha',
  url: 'https://example.com/__harness_eval__/case-alpha',
  html: '<!doctype html><html><head><title>Alpha reference</title></head><body><main><h1>Alpha reference</h1><p>Known fixture text.</p></main></body></html>',
};

test('host-owned evaluation fixture requires the canonical example.com URL and bounded id', () => {
  assert.deepEqual(parseEvaluationFixture(fixture), fixture);
  for (const url of [
    'https://example.com/__harness_eval__/case-alpha?x=1',
    'https://sub.example.com/__harness_eval__/case-alpha',
    'http://example.com/__harness_eval__/case-alpha',
    'https://example.com/__harness_eval__/Case-alpha',
  ]) {
    assert.throws(() => parseEvaluationFixture({...fixture, url}), /canonical host-owned URL/);
  }
  assert.throws(() => parseEvaluationFixture({...fixture, id: '../case-alpha'}), /fixture id/);
});

test('evaluation fixture rejects oversized HTML and external or active resources', () => {
  assert.throws(() => parseEvaluationFixture({...fixture, html: 'x'.repeat(100 * 1024 + 1)}), /100 KiB/);
  for (const html of [
    '<img src="https://example.com/image.png">',
    '<link rel="stylesheet" href="/style.css">',
    '<script>document.location="https://example.com/"</script>',
    '<div onclick="fetch(\'/secret\')">fixture</div>',
    '<style>body{background:url(https://example.com/bg.png)}</style>',
    '<iframe src="https://example.com/child"></iframe>',
  ]) {
    assert.throws(() => parseEvaluationFixture({...fixture, html}), /active content or external resource references/);
  }
});

test('evaluation fixture response permits one exact main-frame document request only', () => {
  const request = {url: fixture.url, resourceType: 'document', isNavigationRequest: true, isMainFrame: true};
  assert.deepEqual(evaluationFixtureResponse(fixture, request, false), {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixture.html,
  });
  assert.equal(evaluationFixtureResponse(fixture, request, true), undefined);
  assert.equal(evaluationFixtureResponse(fixture, {...request, url: `${fixture.url}/other`}, false), undefined);
  assert.equal(evaluationFixtureResponse(fixture, {...request, resourceType: 'image'}, false), undefined);
  assert.equal(evaluationFixtureResponse(fixture, {...request, isMainFrame: false}, false), undefined);
  assert.equal(evaluationFixtureResponse(fixture, {...request, isNavigationRequest: false}, false), undefined);
});

test('evaluation fixture hash is stable and derived from the host-owned HTML bytes', () => {
  assert.match(evaluationFixtureHash(fixture), /^[a-f0-9]{64}$/);
  assert.equal(evaluationFixtureHash(fixture), evaluationFixtureHash({...fixture}));
  assert.notEqual(evaluationFixtureHash(fixture), evaluationFixtureHash({...fixture, html: `${fixture.html} `}));
});
