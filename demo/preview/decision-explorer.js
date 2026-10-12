(() => {
  const root = document.getElementById('explorerContent');
  if (!root) return;
  const select = document.getElementById('explorerTask');
  const replay = document.getElementById('explorerReplay');
  const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const routes = ['pi-browser:configured', 'fal-creative:image-fast', 'fal-creative:image-quality', 'native:defer'];
  const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : 'not measured';
  let timers = [];
  const stop = () => { timers.forEach(clearTimeout); timers = []; root.querySelectorAll('.active').forEach(n => n.classList.remove('active')); };
  const load = async path => { const r = await fetch(path); if (!r.ok) throw new Error(`Evidence HTTP ${r.status}`); return r.json(); };
  Promise.all([load('data/metrics.json'), load('data/browser-comparison.json')]).then(([metrics, pilot]) => {
    const creative = metrics.runs.find(r => r.runId === metrics.composite.creativeRunId);
    const image = metrics.featured.assets.find(a => a.runId === creative.runId);
    function render() {
      stop(); root.replaceChildren();
      const kind = select.value, browser = kind === 'browser', art = kind === 'creative', repo = kind === 'repo';
      const run = browser ? pilot.routed : art ? creative : null;
      const route = browser ? routes[0] : art ? creative.selectedRouteId : repo ? routes[3] : 'no eligible route';
      const method = browser ? 'deterministic · single eligible Pi route · Decisions not required' : art ? 'openai Decisions · recorded selection; full candidate set not exported' : 'policy walkthrough · illustrative routing';
      const prompt = browser ? pilot.task.prompt : art ? 'Generate a 16:9 hero illustration using visual observations passed from the browser task. Brief summarized from the recorded workflow; full prompt is not exported.' : repo ? 'Modify source code and run relevant tests. Illustrative task; no end-to-end repository edit recorded.' : 'Access a private account, generate disabled video, or request unsupported capabilities. Illustrative policy examples.';
      const requirements = browser ? 'browser, screenshot, public_site_research · browser.navigate / extract / screenshot' : art ? 'image, text_to_image · PNG / 1024×576 / artifact verification' : repo ? 'coding, host_owned_tasks' : 'private-account access / video / unknown requirement';
      const bound = browser ? `${pilot.routed.model} (recorded Pi model); configured route profile` : art ? 'fal-ai/flux-2 · image-quality' : repo ? 'current Codex host · no separate Codex adapter' : 'none';
      const status = browser ? 'partial · execution completed, 3/4 task checks passed' : art ? 'completed · artifact verified; aesthetics and style matching unverified' : repo ? 'defer_to_host policy · execution not recorded' : 'rejected policy · execution not recorded';
      const badge = el('p', `${run ? 'recorded execution + policy walkthrough' : 'policy walkthrough only'} · ${status}`); badge.className = 'explorer-status'; root.append(badge);
      const grid = el('div'); grid.className = 'explorer-grid';
      const brief = el('div'); brief.append(el('h3', 'task + extracted requirements'), el('p', prompt), el('p', requirements));
      const selection = el('div'); selection.append(el('h3', 'route + bound execution'), el('code', route), el('p', bound), el('p', method)); grid.append(brief, selection); root.append(grid);
      const policy = el('details'); policy.append(el('summary', 'eligible routes / excluded routes — policy walkthrough'));
      policy.append(el('p', browser ? 'Recorded browser selection used the sole eligible Pi route. fal routes cannot satisfy browser requirements. Runtime health and authorization govern eligibility; exact historical exclusion list is not exported.' : art ? 'Configured image-fast → fal-ai/flux/schnell, estimated $0.003; image-quality → fal-ai/flux-2, estimated $0.012. Actual charges depend on dimensions. Paid authorization, budget and health must pass first. These are configured candidates, not a reconstructed historical eligible list. Pi cannot generate images. Native host fallback depends on task policy.' : repo ? 'native:defer supports host-owned coding. Pi and fal do not satisfy coding requirements. The gateway returns control; host execution is not shown as a harness run.' : 'Permission: private_account_action_denied. Video: video_disabled. Unsupported: unknown_requirement. Budget: budget_below_decision_reserve / budget_exceeded. These produce exclusions and can yield no_eligible_route; no fallback execution is claimed.'));
      root.append(policy);
      const timeline = el('div'); timeline.className = 'explorer-timeline';
      const steps = [
        ['task received', prompt], ['requirements extracted', `${requirements} · summarized policy walkthrough`],
        ['policy filtered routes', 'Capability, permissions, runtime health and budget checked before selection. Full historical exclusions not exported.'],
        ['route selected', `${route} · ${method} · decision duration: ${seconds(run?.timing?.decisionMs)}`],
        ['harness executed', `${bound} · ${status} · execution duration: ${seconds(run?.timing?.executionMs)}`],
        ['acceptance evaluated', browser ? 'passed: title/URL, measured style, screenshot. failed: exact link target.' : art ? 'PNG decoding / dimensions / original hash validated by public snapshot checker. Source-style matching and aesthetics unverified.' : 'not recorded'],
        ['artifacts + trace returned', run ? `runId: ${run.runId} · total server time: ${seconds(run.timing?.totalMs)} · cost: ${run.cost?.status || 'unknown'} · host task latency: not measured` : 'not recorded']
      ];
      steps.forEach(([label, text], i) => { const d = el('details'); d.append(el('summary', `${i + 1}. ${label}`), el('p', text)); timeline.append(d); }); root.append(timeline);
      const evidence = el('div'); evidence.append(el('h3', 'verification + evidence'));
      if (browser) { const checks = el('ul'); checks.className = 'explorer-checks'; pilot.routed.checks.forEach(c => checks.append(el('li', `${c.status} · ${c.label}: ${c.evidence}`))); evidence.append(checks); }
      if (art) { evidence.append(el('p', 'Acceptance: valid PNG, exact 16:9, inspectable artifact. Public snapshot confirms PNG signature, dimensions and SHA-256. Artistic quality / source-style matching: unverified. Full criterion trace is not included in sanitized JSON.'));
        evidence.append(el('p', `browser observations → Codex handoff → fal-creative → generated artifact. Browser parent: ${metrics.composite.browserRunId}; creative child: ${creative.runId}. Relationship recorded in featured composite; parentRunId is not separately exported in per-run JSON.`));
        evidence.append(el('p', `${image.width} × ${image.height} · SHA-256: ${image.sha256}`)); }
      const path = browser ? pilot.routed.screenshotPath : art ? image.path : null;
      if (path && /^assets\/[\w./-]+\.(png|jpg)$/.test(path) && !path.includes('..')) { const a = el('a'); a.href = path; const img = el('img'); img.src = path; img.alt = browser ? 'Actual recorded Pi browser screenshot' : 'Verified generated hero illustration'; img.className = 'explorer-artifact'; a.append(img); evidence.append(a); }
      const link = el('a', run ? 'open corresponding public evidence JSON ↗' : 'inspect recorded evidence ↗'); link.href = browser ? 'data/browser-comparison.json' : art ? creative.evidenceFile : 'evidence.html'; evidence.append(link); root.append(evidence);
    }
    select.addEventListener('change', render);
    replay.addEventListener('click', () => { stop(); const nodes = [...root.querySelectorAll('.explorer-timeline details')]; if (matchMedia('(prefers-reduced-motion: reduce)').matches) { nodes.forEach(n => n.open = true); return; } nodes.forEach((n, i) => timers.push(setTimeout(() => { nodes.forEach(x => x.classList.remove('active')); n.classList.add('active'); }, i * 450))); timers.push(setTimeout(stop, nodes.length * 450)); });
    render();
  }).catch(error => { root.textContent = `Public evidence could not load: ${error.message}. Serve the static demo over HTTP.`; root.setAttribute('role', 'alert'); replay.disabled = true; });
})();
