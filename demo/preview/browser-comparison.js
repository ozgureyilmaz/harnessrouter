(() => {
  const section = document.querySelector('[data-browser-experiment]');
  if (!section) return;
  const evidence = section.dataset.browserExperiment === 'evidence';
  const node = (tag, cls, text) => {
    const n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text; return n;
  };
  const safeShot = path => /^assets\/browser-pilot\/(codex-browser\.jpg|pi-browser\.png)$/.test(path || '') ? path : null;
  const stage = node('div', 'comparison-stage'); section.append(stage);
  const loading = node('p', 'browser-result', 'Loading the saved browser experiment…'); stage.append(loading);
  fetch('data/browser-comparison.json', {cache:'no-store'}).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
  }).then(data => {
    if (data.schemaVersion !== '1.0' || !data.native || !data.routed) throw new Error('Invalid experiment record');
    stage.replaceChildren();
    const top = node('div', 'comparison-top'), title = node('div');
    title.append(node('div','eyebrow','Browser task · two actual runs'),node('h2','', 'Codex browser vs Pi through MCP'));
    const controls = node('div','comparison-controls'); top.append(title,controls); stage.append(top);
    let timers=[]; const allSteps=[];
    const stop=()=>{timers.forEach(clearTimeout);timers=[];allSteps.forEach(n=>n.classList.remove('is-pending','is-active'));};
    if (!evidence) {
      const play=node('button','button','Play recorded browser flow');play.type='button';play.id='browserPlay';
      play.addEventListener('click',()=>{stop();play.disabled=true;allSteps.forEach(n=>n.classList.add('is-pending'));
        for(let i=0;i<4;i++) timers.push(setTimeout(()=>{allSteps.filter(n=>Number(n.dataset.step)===i).forEach(n=>{n.classList.remove('is-pending');n.classList.add('is-active');});},i*700));
        timers.push(setTimeout(()=>{stop();play.disabled=false;},3100));});
      const capture=node('button','button','Browser GIF view');capture.type='button';capture.id='browserCapture';
      capture.addEventListener('click',()=>{document.body.dataset.captureTarget='browser';document.body.classList.add('capture-mode');});
      const exit=node('button','button capture-exit','Exit GIF view');exit.type='button';exit.addEventListener('click',()=>document.body.classList.remove('capture-mode'));
      controls.append(play,capture,exit);
      document.getElementById('enterCapture')?.addEventListener('click',()=>{document.body.dataset.captureTarget='composite';});
      document.addEventListener('keydown',event=>{if(event.key==='Escape')document.body.classList.remove('capture-mode');});
    }
    stage.append(node('div','comparison-prompt','Shared task: inspect example.com, return title + notice + exact link, measure visual style, and save a verified 1280×720 screenshot.'));
    const lanes=node('div','comparison-lanes');stage.append(lanes);
    for(const [key,label] of [['native','Codex only · native browser'],['routed','Codex + harnessrouter · Pi']]){
      const run=data[key],passed=run.checks.filter(c=>c.status==='passed').length;
      const arm=node('article','browser-arm'),head=node('div','browser-arm-head');
      head.append(node('span','',label),node('span',`browser-badge ${run.status==='partial'?'partial':''}`,`${passed}/${run.checks.length} checks · ${run.status}`));arm.append(head);
      const metrics=node('div','browser-metrics');
      const metric=(label,value,note)=>{const m=node('div','browser-metric');m.append(node('span','',label),node('strong','',value),node('small','',note));metrics.append(m);};
      const executionUsage=run.executionUsage||run.usage;
      if(run.executionWindow) metric('Host + executor window',`≈ ${(run.executionWindow.ms/1000).toFixed(2)} s`,'Log interval proxy · not full task latency');
      metric(key==='native'?'Browser tool block':'MCP server total',`${(run.processingMs/1000).toFixed(2)} s`,key==='native'?'Measured tool time; included in window':'Includes Pi reasoning; included in window');
      metric('Execution-response tokens',executionUsage?.tokens?.totalTokens?.toLocaleString()||'Unavailable',key==='native'?`${executionUsage.tokens.cachedInputTokens.toLocaleString()} cached input · context included`:`${executionUsage.hostTokens?.toLocaleString()} host + ${executionUsage.piTokens?.toLocaleString()} Pi`);
      metric('API-equivalent estimate',Number.isFinite(run.apiEquivalentCost?.usd)?`≈ $${run.apiEquivalentCost.usd.toFixed(4)}`:'Unknown','Standard rate reference · actual billing unknown');
      metric('Model',run.model||'Not reported',key==='native'?`Session log verified · ${run.reasoningEffort||''}`:`Host: ${run.hostModel||'not reported'}`);arm.append(metrics);
      const steps=node('ol','browser-steps');run.checks.forEach((check,index)=>{
        const s=node('li',`browser-step ${check.status==='failed'?'failed':''}`);s.dataset.step=index;s.title=check.evidence;
        s.append(node('b','',check.status==='passed'?'✓':'!'),node('span','',check.label));steps.append(s);allSteps.push(s);
      });arm.append(steps);
      const shot=safeShot(run.screenshotPath);if(shot){const a=node('a','browser-shot');a.href=shot;a.target='_blank';a.rel='noreferrer';a.setAttribute('aria-label',`Open ${label} screenshot`);const img=node('img');img.src=shot;img.alt=`Actual screenshot from ${label}`;a.append(img);arm.append(a);}
      arm.append(node('p','browser-result',key==='native'?'Exact link observed: Learn more → https://iana.org/help/example-domains':'Task partial: Pi reported the link target as uncertain. Runtime completed; screenshot and style checks passed.'));
      if(evidence) arm.append(node('p','mono',`Run: ${run.runId}`));lanes.append(arm);
    }
    stage.append(node('div','browser-limit','Execution windows include one host response + tools; earlier setup and later review are excluded. Tokens include existing context/cache. USD values are Standard API-rate estimates, not subscription invoices. One live pair; no general advantage established.'));
    const footer=node('div','comparison-footer');footer.append(node('span','', 'Saved real runs · playback is illustrative and makes no provider calls.'));
    const a=node('a','',evidence?'Download browser metrics JSON':'Browser run evidence ↗');a.href=evidence?'data/browser-comparison.json':'evidence.html#browserComparison';if(evidence)a.download='browser-comparison.json';footer.append(a);stage.append(footer);
    if(evidence){const details=node('details'),summary=node('summary','','Exact shared brief and measurement limits');details.append(summary,node('pre','',data.task.prompt+'\n\n'+data.comparability.limitations.join('\n')));if(data.pricingReference){details.append(node('pre','',JSON.stringify({nativeTokens:data.native.executionUsage?.tokens,routedHostTokens:data.routed.hostUsage?.tokens,piTokens:data.routed.usage?.tokens,pricing:data.pricingReference},null,2)));const source=node('a','','Official OpenAI API rates');source.href=data.pricingReference.source;source.target='_blank';source.rel='noreferrer';details.append(source);}stage.append(details);}
  }).catch(error=>{loading.textContent=`Browser evidence could not load: ${error.message}. Open through the preview server.`;loading.setAttribute('role','alert');});
})();
