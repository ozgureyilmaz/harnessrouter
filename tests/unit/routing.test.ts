import assert from 'node:assert/strict';
import test from 'node:test';
import type {HarnessTask, Health, Registry} from '../../src/domain/types.js';
import {getEligibleRoutes} from '../../src/registry/eligibility.js';
import {buildDecisionChoices, findEligibleRoute} from '../../src/routing/selector.js';

const registry: Registry = {
  version: 1,
  harnesses: [
    {
      id: 'pi-browser', kind: 'external_agent_runtime', transport: 'pi_rpc', enabled: true,
      permissions: ['public_web_read', 'screenshot'],
      capabilities: ['browser.navigate', 'browser.extract', 'browser.screenshot'], default_timeout_ms: 120_000,
      routes: [{
        id: 'pi-browser:configured', description: 'Pi browser route', agent_model_profile: 'configured',
        modalities: ['text', 'screenshot'], eligible_requirements: ['browser', 'screenshot', 'public_site_research'],
        price_usd: null, price_status: 'not_applicable', enabled: true,
      }],
    },
    {
      id: 'fal-creative', kind: 'custom_agent_harness', transport: 'in_process', enabled: true,
      permissions: ['paid_media_generation'], capabilities: ['media.text_to_image'], default_timeout_ms: 180_000,
      routes: [{
        id: 'fal-creative:image-fast', description: 'Fast image route', generation_model_id: 'fal-ai/flux/schnell',
        modalities: ['image'], eligible_requirements: ['text_to_image', 'image'], price_usd: 0.003,
        price_status: 'estimated', enabled: true,
      }],
    },
    {
      id: 'native', kind: 'host_defer', transport: 'none', enabled: true,
      permissions: [], capabilities: ['coding', 'host_owned_tasks'], default_timeout_ms: 0,
      routes: [{
        id: 'native:defer', description: 'Return to host', modalities: ['text'],
        eligible_requirements: ['coding', 'unsupported_fallback'], price_usd: null,
        price_status: 'not_applicable', enabled: true,
        fallback_requirements: ['browser', 'screenshot', 'public_site_research', 'image', 'text_to_image'],
      }],
    },
  ],
};

const health: Record<string, Health> = {
  'pi-browser': {available: true, provider: 'openai-codex', modelId: 'gpt-5.5'},
  'fal-creative': {available: true, provider: 'fal'},
  native: {available: true, provider: 'host'},
};

const basePolicy = {
  selector:'decisions' as const,
  allowPaid: true,
  allowExecution: true,
  dryRun: false,
  allowedDomains: ['example.com'],
  remainingBudgetUsd: 1,
  credentials: {openai: false, fal: true},
};

function task(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    schemaVersion: '1.0', taskId: 'task-1', prompt: 'Complete the task', requirements: ['coding'],
    acceptanceCriteria: ['Return a useful result'], ...overrides,
  };
}

test('eligibility selects only the native route for host-owned coding', () => {
  const result = getEligibleRoutes(task(), registry, health, {...basePolicy, dryRun: true, allowPaid: false});
  assert.deepEqual(result.eligible.map(item => item.route.id), ['native:defer']);
  assert.deepEqual(buildDecisionChoices(result.eligible).map(choice => choice.value), ['native:defer']);
  assert.equal(findEligibleRoute('native:defer', result.eligible).harness.id, 'native');
  assert.throws(() => findEligibleRoute('pi-browser:configured', result.eligible), {code: 'invalid_decision'});
});

test('eligibility requires health and exact route capability coverage', () => {
  const browserTask = task({
    requirements: ['browser', 'screenshot', 'public_site_research'],
    desiredOutput: 'text',
    prompt: 'Inspect https://example.com and take a screenshot.',
    allowedDomains: ['example.com'],
    allowUnknownCost: true,
  });
  const result = getEligibleRoutes(browserTask, registry, {
    'pi-browser': {available: true, provider: 'openai-codex'}, native: health.native!,
  }, basePolicy);
  assert.deepEqual(result.eligible.map(item => item.route.id), ['pi-browser:configured', 'native:defer']);
  const fallback = result.eligible[1]!;
  assert.deepEqual(fallback.route.modalities, ['text']);
  assert.deepEqual(fallback.route.eligible_requirements, ['coding', 'unsupported_fallback']);
  assert.match(fallback.route.description, /^Control fallback:/);

  const missingHealth = getEligibleRoutes(browserTask, registry, {}, basePolicy);
  assert.deepEqual(missingHealth.eligible, []);
  assert.equal(missingHealth.excluded.find(item => item.id === 'pi-browser:configured')?.reason, 'health_not_checked');
});

test('Pi execution and unknown-cost authorization are independent of the selector and provider', () => {
  const browserTask = task({
    requirements: ['browser'], desiredOutput: 'text',
    prompt: 'Inspect https://example.com.', allowedDomains: ['example.com'],
    allowUnknownCost: true,
  });
  const modes = [
    {name: 'OpenAI hosted selector', selector: 'decisions' as const, decisionRequiresPaid: true, allowPaid: true},
    {name: 'Jev hosted selector', selector: 'decisions' as const, decisionRequiresPaid: true, allowPaid: true},
    {name: 'Ollaya local provider', selector: 'decisions' as const, decisionRequiresPaid: false, allowPaid: false},
    {name: 'local route ranking', selector: 'local' as const, decisionRequiresPaid: true, allowPaid: false},
  ];
  for (const mode of modes) {
    const policy = {...basePolicy, ...mode};
    const authorized = getEligibleRoutes(browserTask, registry, health, policy);
    assert.equal(authorized.eligible.some(item => item.harness.id === 'pi-browser'), true, mode.name);
    for (const allowExecution of [false, undefined]) {
      const denied = getEligibleRoutes(browserTask, registry, health, {...policy, allowExecution});
      assert.equal(denied.eligible.some(item => item.harness.id === 'pi-browser'), false, mode.name);
      assert.equal(denied.excluded.find(item => item.id === 'pi-browser:configured')?.reason, 'unknown_cost_execution_not_authorized');
    }
    for (const allowUnknownCost of [false, undefined]) {
      const denied = getEligibleRoutes({...browserTask, allowUnknownCost}, registry, health, policy);
      assert.equal(denied.eligible.some(item => item.harness.id === 'pi-browser'), false, mode.name);
      assert.equal(denied.excluded.find(item => item.id === 'pi-browser:configured')?.reason, 'unknown_cost_execution_not_authorized');
    }
  }
});

test('eligibility excludes routes that lack any explicitly required execution capability', () => {
  const formTask = task({
    requirements: ['browser', 'screenshot'],
    requiredCapabilities: ['browser.form_interaction'],
    desiredOutput: 'screenshot',
    prompt: 'Verify invalid email feedback on a public demo form.',
    allowedDomains: ['example.com'],
  });
  const result = getEligibleRoutes(formTask, registry, health, basePolicy);
  assert.deepEqual(result.eligible, []);
  assert.equal(result.excluded.find(item => item.id === 'pi-browser:configured')?.reason,
    'capability_not_supported:browser.form_interaction');
});

test('eligibility excludes external routes when paid Decisions selection is not authorized', () => {
  const browserTask = task({
    requirements: ['browser', 'screenshot'], desiredOutput: 'screenshot',
    prompt: 'Inspect https://example.com and capture a screenshot.', allowedDomains: ['example.com'],
    allowUnknownCost: true,
  });
  const result = getEligibleRoutes(browserTask, registry, health, {...basePolicy, allowPaid: false});
  assert.deepEqual(result.eligible, []);
  assert.equal(result.excluded.find(item => item.id === 'pi-browser:configured')?.reason,
    'decision_paid_call_not_authorized');
});

test('native control fallback is never offered without a live eligible specialist', () => {
  const imageTask = task({
    prompt: 'Create a landing page illustration.', requirements: ['text_to_image', 'image'],
    desiredOutput: 'image', allowPaidExecution: true,
  });
  const noFalCredential = getEligibleRoutes(imageTask, registry, health, {
    ...basePolicy, credentials: {openai: false, fal: false},
  });
  assert.equal(noFalCredential.eligible.some(item => item.harness.id === 'native'), false);

  const noFalHealth = getEligibleRoutes(imageTask, registry, {...health, 'fal-creative': {available: false}}, basePolicy);
  assert.equal(noFalHealth.eligible.some(item => item.harness.id === 'native'), false);

  const noDecisionApproval = getEligibleRoutes(imageTask, registry, health, {...basePolicy, allowPaid: false});
  assert.equal(noDecisionApproval.eligible.some(item => item.harness.id === 'native'), false);
});

test('task domains cannot expand the configured browser allowlist', () => {
  const browserTask = task({
    requirements: ['browser', 'screenshot'], desiredOutput: 'screenshot',
    prompt: 'Inspect https://outside.example and capture a screenshot.', allowedDomains: ['outside.example'],
  });
  const result = getEligibleRoutes(browserTask, registry, health, basePolicy);
  assert.equal(result.eligible.some(item => item.harness.id === 'pi-browser'), false);
  assert.equal(result.excluded.find(item => item.id === 'pi-browser:configured')?.reason, 'domain_outside_configured_allowlist');
});

test('browser context URLs must also be inside the task and configured allowlists', () => {
  const browserTask = task({
    requirements: ['browser', 'screenshot'], desiredOutput: 'screenshot',
    prompt: 'Inspect the approved page.', allowedDomains: ['example.com'],
    context: {url: 'https://outside.example/private'},
  });
  const result = getEligibleRoutes(browserTask, registry, health, basePolicy);
  assert.equal(result.eligible.some(item => item.harness.id === 'pi-browser'), false);
  assert.equal(result.excluded.find(item => item.id === 'pi-browser:configured')?.reason, 'task_url_domain_not_authorized');
});

test('private account, video, and unknown requirements produce no routes', () => {
  const privateTask = getEligibleRoutes(task({
    prompt: 'Transfer money through my private bank account.', requirements: ['private_account_action'],
  }), registry, health, basePolicy);
  assert.equal(privateTask.eligible.length, 0);
  assert.equal(privateTask.excluded[0]?.reason, 'private_account_action_denied');

  const videoTask = getEligibleRoutes(task({requirements: ['text_to_video'], desiredOutput: 'video'}), registry, health, basePolicy);
  assert.equal(videoTask.eligible.length, 0);
  assert.equal(videoTask.excluded.every(item => item.reason === 'video_disabled'), true);

  const unknownTask = getEligibleRoutes(task({requirements: ['coding', 'arbitrary_execution']}), registry, health, basePolicy);
  assert.equal(unknownTask.eligible.length, 0);
  assert.equal(unknownTask.excluded.every(item => item.reason === 'unknown_requirement:arbitrary_execution'), true);
});

test('paid routes require policy approval, task approval, credentials, and sufficient budget', () => {
  const imageTask = task({
    prompt: 'Create an illustration.', requirements: ['text_to_image', 'image'],
    desiredOutput: 'image', allowPaidExecution: true, maxCostUsd: 0.02,
  });
  assert.deepEqual(getEligibleRoutes(imageTask, registry, health, basePolicy).eligible.map(item => item.route.id), ['fal-creative:image-fast', 'native:defer']);
  assert.equal(getEligibleRoutes({...imageTask, allowPaidExecution: false}, registry, health, basePolicy).eligible.length, 0);
  assert.equal(getEligibleRoutes(imageTask, registry, health, {...basePolicy, allowPaid: false}).eligible.length, 0);
  assert.equal(getEligibleRoutes(imageTask, registry, health, {...basePolicy, credentials: {openai: false, fal: false}}).eligible.length, 0);
  assert.equal(getEligibleRoutes({...imageTask, maxCostUsd: 0.001}, registry, health, basePolicy).eligible.length, 0);
  assert.equal(getEligibleRoutes({...imageTask, maxCostUsd: 0.012}, registry, health, basePolicy).eligible.length, 0);
});

test('desired output is combined with required modalities, and dry run excludes external execution', () => {
  const imageTask = task({
    prompt: 'Create an illustration.', requirements: ['text_to_image', 'image'],
    desiredOutput: 'image', allowPaidExecution: true,
  });
  const dry = getEligibleRoutes(imageTask, registry, health, {...basePolicy, dryRun: true});
  assert.equal(dry.eligible.length, 0);
  assert.equal(dry.excluded.find(item => item.id === 'fal-creative:image-fast')?.reason, 'dry_run_execution_disabled');

  const contradictory = getEligibleRoutes(task({
    prompt: 'Create an illustration.', requirements: ['text_to_image', 'image'], desiredOutput: 'text',
    allowPaidExecution: true,
  }), registry, health, basePolicy);
  assert.equal(contradictory.eligible.length, 0);
  assert.equal(contradictory.excluded.find(item => item.id === 'fal-creative:image-fast')?.reason, 'modality_not_supported:text');

  const mixed = getEligibleRoutes(task({
    requirements: ['browser', 'screenshot', 'public_site_research'], desiredOutput: 'mixed',
    prompt: 'Inspect https://example.com.', allowedDomains: ['example.com'],
  }), registry, health, basePolicy);
  assert.equal(mixed.eligible.length, 0);
  assert.equal(mixed.excluded.find(item => item.id === 'pi-browser:configured')?.reason, 'modality_not_supported:mixed');
});

test('registry cannot introduce unsupported harnesses, transports, bindings, or Pi models', () => {
  const unknownHarness = structuredClone(registry);
  unknownHarness.harnesses[0]!.id = 'unreviewed-agent';
  assert.throws(() => getEligibleRoutes(task(), unknownHarness, health, basePolicy), {code: 'registry_unsupported'});

  const wrongTransport = structuredClone(registry);
  wrongTransport.harnesses[0]!.transport = 'in_process';
  assert.throws(() => getEligibleRoutes(task(), wrongTransport, health, basePolicy), {code: 'registry_unsupported'});

  const wrongPrefix = structuredClone(registry);
  wrongPrefix.harnesses[0]!.routes[0]!.id = 'other:route';
  assert.throws(() => getEligibleRoutes(task(), wrongPrefix, health, basePolicy), {code: 'registry_unsupported'});

  const unsupportedPiModel = structuredClone(registry);
  unsupportedPiModel.harnesses[0]!.routes[0]!.agent_model_profile = 'gpt-5.5';
  assert.throws(() => getEligibleRoutes(task(), unsupportedPiModel, health, basePolicy), {code: 'registry_unsupported'});

  const nonNativeFallback = structuredClone(registry);
  nonNativeFallback.harnesses[0]!.routes[0]!.fallback_requirements = ['browser'];
  assert.throws(() => getEligibleRoutes(task(), nonNativeFallback, health, basePolicy), {code: 'registry_unsupported'});

  const unsafeNativeFallback = structuredClone(registry);
  unsafeNativeFallback.harnesses[2]!.routes[0]!.fallback_requirements = ['unsupported_fallback'];
  assert.throws(() => getEligibleRoutes(task(), unsafeNativeFallback, health, basePolicy), {code: 'registry_unsupported'});
});
