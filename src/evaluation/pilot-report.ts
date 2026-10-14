import type {PilotTrialOutcome} from './pilot-engine.js';

type Score={dimension:string;score:number;reason?:string;evidence?:string[]};
type JudgeOutcome={status:string;passed?:boolean;scores?:Score[]|Record<string,number|null|undefined>;reason?:string;error?:string;durationMs?:number;cost?:{status?:string;usd?:number};costComponent?:{status?:string;usd?:number};usage?:{tokens?:{inputTokens?:number;outputTokens?:number;totalTokens?:number}};tracePath?:string;[key:string]:unknown};
type TechnicalCheck={name:string;passed:boolean;evidence:string};
type PilotStepReport=PilotTrialOutcome['steps'][number]&{
  technicalChecks?:TechnicalCheck[];reference?:unknown;error?:string;
  semantic?:JudgeOutcome;
};
export type PilotReport={
  id:string;startedAt?:string;requestedTrials:number;requestedSteps:number;results:PilotTrialOutcome[];
  phase?:'running'|'finished';
  suiteHash?:string;sourceVersions?:Record<string,string>;judge?:unknown;budget?:unknown;
  stopReason?:string;checks?:unknown;
};

type Group={harness:string;environment:string;route:string;attempted:number;skipped:number;technicalPass:number;semanticPass:number;semanticFail:number;ungraded:number;latencies:number[];inputTokens:number;outputTokens:number;tokenSamples:number;knownCost:number;unknownCost:number};
type JudgeGroup={harness:string;environment:string;route:string;calls:number;latencies:number[];inputTokens:number;outputTokens:number;tokenSamples:number;knownCost:number;unknownCost:number};
type Issue={caseId:string;rep:number;step:string;priority:number;issue:string;evidence:string};
const median=(values:number[]):number|null=>{if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;};
const p95=(values:number[]):number|null=>{if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a[Math.max(0,Math.ceil(a.length*.95)-1)]!;};
const num=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const inline=(value:unknown)=>String(value??'').replaceAll('|','\\|').replace(/[\r\n]+/g,' ');
function groupKey(harness:string,environment:string,route:string):string{return [harness,environment,route].join('|');}
function normalizeScores(scores:JudgeOutcome['scores']):Score[]{
  if(Array.isArray(scores))return scores.filter((s):s is Score=>!!s&&typeof s.dimension==='string'&&num(s.score));
  if(scores&&typeof scores==='object')return Object.entries(scores).filter(([,score])=>num(score)).map(([dimension,score])=>({dimension,score:score as number}));
  return [];
}
function semanticBucket(step:PilotStepReport):'pass'|'fail'|'ungraded'{
  const s=step.semantic;if(!s||s.status==='unverified')return 'ungraded';
  if(s.status==='scored')return s.passed===true?'pass':'fail';
  if(s.status==='passed')return 'pass';
  if(s.status==='failed')return 'fail';
  return 'ungraded';
}
function localEvidence(step:PilotStepReport):string{
  const paths=[step.tracePath,step.result?.tracePath,step.semantic?.tracePath,...(step.result?.artifacts??[]).map(a=>a.path)].filter((p):p is string=>!!p);
  const unique=[...new Set(paths)];
  return unique.length?unique.map(p=>`[${inline(p)}](${inline(p).replaceAll(' ','%20')})`).join(', '):(step.runId?`run ${inline(step.runId)}`:'kanıt yolu yok');
}
function issueRows(trial:PilotTrialOutcome,step:PilotStepReport):Issue[]{
  const rows:Issue[]=[];const evidence=localEvidence(step);
  if(step.error)rows.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority:1,issue:`Teknik hata: ${step.error}`,evidence});
  for(const check of step.technicalChecks??[])if(!check.passed)rows.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority:1,issue:`Teknik kontrol ${check.name}: ${check.evidence}`,evidence});
  if(!step.technicalPassed&&!step.error&&!(step.technicalChecks??[]).some(check=>!check.passed))rows.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority:1,issue:`Teknik doğrulama başarısız (${step.status})`,evidence});
  const semantic=step.semantic;
  if(semantic?.status==='unverified')rows.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority:1,issue:`Hakem notlandırmadı: ${semantic.error??semantic.reason??'neden belirtilmedi'}`,evidence:localEvidence(step)});
  for(const score of normalizeScores(semantic?.scores))if(score.score<3){
    const priority=score.score<2?1:2;const detail=[score.reason,score.evidence?.length?`kanıt: ${score.evidence.join('; ')}`:undefined].filter(Boolean).join(' — ');
    rows.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority,issue:`${score.dimension}: ${score.score}/4${detail?` — ${detail}`:''}`,evidence:localEvidence(step)});
  }
  if(semantic&&semantic.status!=='unverified'&&semanticBucket(step)==='fail'&&!normalizeScores(semantic.scores).some(s=>s.score<3))rows.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority:1,issue:`Semantik sonuç başarısız: ${semantic.reason??semantic.error??'passed=false'}`,evidence:localEvidence(step)});
  return rows;
}
/** Render a compact, evidence-linked Turkish Markdown pilot report. Scores remain provisional. */
export function renderPilotReport(report:PilotReport):string{
  const groups=new Map<string,Group>(),judgeGroups=new Map<string,JudgeGroup>(),dimensionScores=new Map<string,number[]>();
  const issues:Issue[]=[];let attempts=0,skippedTrials=0,stepAttempts=0,explicitSkipped=0,technicalPass=0,semanticPass=0,semanticFail=0,ungraded=0,knownCost=0,unknownCost=0;
  let judgeKnownCost=0,judgeUnknownCost=0,judgeCalls=0,judgeInputTokens=0,judgeOutputTokens=0,judgeTokenSamples=0;const judgeLatencies:number[]=[];
  let inputTokens=0,outputTokens=0,tokenSamples=0;const latencies:number[]=[];
  for(const rawTrial of report.results){
    const trial=rawTrial;const steps=trial.steps as PilotStepReport[];
    if(trial.status==='skipped')skippedTrials++;else attempts++;
    if(trial.status==='skipped'&&steps.length===0)issues.push({caseId:trial.caseId,rep:trial.repetition,step:'—',priority:1,issue:`Trial atlandı: ${trial.skipReason??report.stopReason??'çalıştırılmadı'}`,evidence:'kanıt yolu yok'});
    for(const step of steps){
      const route=step.routeId??step.result?.selectedRouteId??'(rota bilinmiyor)';
      const key=groupKey(step.harnessId,trial.environment,route);
      let g=groups.get(key);if(!g){g={harness:step.harnessId,environment:trial.environment,route,attempted:0,skipped:0,technicalPass:0,semanticPass:0,semanticFail:0,ungraded:0,latencies:[],inputTokens:0,outputTokens:0,tokenSamples:0,knownCost:0,unknownCost:0};groups.set(key,g);}
      if(trial.status==='skipped'||step.status==='skipped'){
        g.skipped++;explicitSkipped++;
        issues.push({caseId:trial.caseId,rep:trial.repetition,step:step.stepId,priority:1,issue:`Adım atlandı: ${step.error??trial.skipReason??'çalıştırılmadı'}`,evidence:localEvidence(step)});
        continue;
      }
      g.attempted++;stepAttempts++;if(step.technicalPassed){g.technicalPass++;technicalPass++;}
      const sem=semanticBucket(step);if(sem==='pass'){g.semanticPass++;semanticPass++;}else if(sem==='fail'){g.semanticFail++;semanticFail++;}else{g.ungraded++;ungraded++;}
      const ms=step.result?.timing?.totalMs;if(num(ms)&&ms>=0){g.latencies.push(ms);latencies.push(ms);}
      const usage=step.result?.usage??[];const hasTokenRecord=usage.some(u=>num(u.tokens?.inputTokens)||num(u.tokens?.outputTokens)||num(u.tokens?.totalTokens));
      if(hasTokenRecord){for(const u of usage){g.inputTokens+=u.tokens?.inputTokens??0;g.outputTokens+=u.tokens?.outputTokens??0;inputTokens+=u.tokens?.inputTokens??0;outputTokens+=u.tokens?.outputTokens??0;}g.tokenSamples++;tokenSamples++;}
      const costs=step.result?.costComponents?.length?step.result.costComponents:(step.result?.cost?[step.result.cost]:[]);let gotCost=false;
      for(const c of costs){if(num(c.usd)){g.knownCost+=c.usd;knownCost+=c.usd;gotCost=true;}if(c.status==='unknown'){g.unknownCost++;unknownCost++;}}
      if(!gotCost&&costs.length===0){g.unknownCost++;unknownCost++;}
      issues.push(...issueRows(trial,step));
      const semantic=step.semantic;
      if(semantic){
        const jk=groupKey(step.harnessId,trial.environment,route);let jg=judgeGroups.get(jk);
        if(!jg){jg={harness:step.harnessId,environment:trial.environment,route,calls:0,latencies:[],inputTokens:0,outputTokens:0,tokenSamples:0,knownCost:0,unknownCost:0};judgeGroups.set(jk,jg);}
        jg.calls++;judgeCalls++;
        if(num(semantic.durationMs)&&semantic.durationMs>=0){jg.latencies.push(semantic.durationMs);judgeLatencies.push(semantic.durationMs);}
        const jt=semantic.usage?.tokens;const hasJudgeTokens=!!jt&&(num(jt.inputTokens)||num(jt.outputTokens)||num(jt.totalTokens));
        if(hasJudgeTokens){jg.inputTokens+=jt!.inputTokens??0;jg.outputTokens+=jt!.outputTokens??0;judgeInputTokens+=jt!.inputTokens??0;judgeOutputTokens+=jt!.outputTokens??0;jg.tokenSamples++;judgeTokenSamples++;}
        const cost=semantic.costComponent??semantic.cost;
        if(cost&&num(cost.usd)){jg.knownCost+=cost.usd;judgeKnownCost+=cost.usd;}
        if(!cost||cost.status==='unknown'||cost.usd===undefined){jg.unknownCost++;judgeUnknownCost++;}
        for(const score of normalizeScores(semantic.scores)){const scores=dimensionScores.get(score.dimension)??[];scores.push(score.score);dimensionScores.set(score.dimension,scores);}
      }
    }
  }
  const finished=report.phase==='finished'||report.phase===undefined&&report.results.length>=report.requestedTrials;
  const skippedSteps=finished?Math.max(explicitSkipped,Math.max(0,report.requestedSteps-stepAttempts)):explicitSkipped;
  const pendingSteps=finished?0:Math.max(0,report.requestedSteps-stepAttempts-explicitSkipped);
  const unattributedSkipped=Math.max(0,skippedSteps-explicitSkipped);
  const lines=[`# Pilot değerlendirme raporu: ${inline(report.id)}`,'',`- Başlangıç: ${inline(report.startedAt??'belirtilmedi')}`,
    `- Deneme kapsamı: ${report.results.length}/${report.requestedTrials} trial kaydı; ${stepAttempts} denenmiş, ${skippedSteps} atlanmış, ${pendingSteps} bekleyen adım (beklenen toplam ${report.requestedSteps})`,
    `- Trial durumu: ${attempts} çalıştırılmış, ${skippedTrials} atlanmış${report.stopReason?`; durdurma nedeni: ${inline(report.stopReason)}`:''}`,'',
    '## Harness sonuçları (harness süresi ve maliyeti)', '', '| Harness | Ortam | Rota | Denendi | Atlandı | Teknik geçti | Semantik geçti | Semantik kaldı | Notlandırılmadı | Medyan süre | p95 süre | Girdi / çıktı tokenı | Bilinen/tahmini maliyet | Bilinmeyen bileşen |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const g of groups.values())lines.push(`| ${inline(g.harness)} | ${inline(g.environment)} | ${inline(g.route)} | ${g.attempted} | ${g.skipped} | ${g.technicalPass} | ${g.semanticPass} | ${g.semanticFail} | ${g.ungraded} | ${median(g.latencies)===null?'—':`${median(g.latencies)} ms`} | ${p95(g.latencies)===null?'—':`${p95(g.latencies)} ms`} | ${g.tokenSamples?`${g.inputTokens} / ${g.outputTokens}`:'bilinmiyor'} | $${g.knownCost.toFixed(4)} | ${g.unknownCost} |`);
  if(unattributedSkipped)lines.push(`| bilinmiyor | eşleşmeyen atlanan trial | rota bilinmiyor | 0 | ${unattributedSkipped} | 0 | 0 | 0 | 0 | — | — | bilinmiyor | $0.0000 | 0 |`);
  if(!groups.size&&!unattributedSkipped)lines.push('| — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | — | — | bilinmiyor | $0.0000 | 0 |');
  lines.push('',`* Harness ölçümleri: ${tokenSamples} adımda token verisi; toplam girdi ${inputTokens}, çıktı ${outputTokens}. Süre n=${latencies.length}; medyan ${median(latencies)??'—'} ms, p95 ${p95(latencies)??'—'} ms. Hakem süresi bu toplama eklenmez.`,
    `* Harness bilinen/tahmini maliyet alt toplamı **$${knownCost.toFixed(4)}**; bilinmeyen bileşen sayısı **${unknownCost}**. Bu tutar tam maliyet iddiası değildir.`,
    '', '## Semantik hakem ölçümleri (ayrı)', '', '| Harness | Ortam | Rota | Hakem çağrısı | Medyan hakem süresi | p95 hakem süresi | Hakem girdi/çıktı tokenı | Bilinen/tahmini hakem maliyeti | Bilinmeyen hakem maliyeti |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|');
  for(const g of judgeGroups.values())lines.push(`| ${inline(g.harness)} | ${inline(g.environment)} | ${inline(g.route)} | ${g.calls} | ${median(g.latencies)===null?'—':`${median(g.latencies)} ms`} | ${p95(g.latencies)===null?'—':`${p95(g.latencies)} ms`} | ${g.tokenSamples?`${g.inputTokens} / ${g.outputTokens}`:'bilinmiyor'} | $${g.knownCost.toFixed(4)} | ${g.unknownCost} |`);
  if(!judgeGroups.size)lines.push('| — | — | — | 0 | — | — | bilinmiyor | $0.0000 | 0 |');
  lines.push('',`* Hakem toplamı: ${judgeCalls} çağrı; ${judgeTokenSamples} çağrıda token ölçümü (${judgeInputTokens} girdi / ${judgeOutputTokens} çıktı); ölçülen hakem süresi medyan ${median(judgeLatencies)??'—'} ms, p95 ${p95(judgeLatencies)??'—'} ms; bilinen/tahmini maliyet **$${judgeKnownCost.toFixed(4)}**, bilinmeyen bileşen ${judgeUnknownCost}. Harness süre ve maliyetine dahil değildir.`,
    '', '## Semantik puan ortalamaları', '', '| Boyut | Puan ortalaması / 4 | Ölçüm sayısı |', '|---|---:|---:|');
  for(const [dimension,scores] of dimensionScores)lines.push(`| ${inline(dimension)} | ${(scores.reduce((sum,n)=>sum+n,0)/scores.length).toFixed(2)} | ${scores.length} |`);
  if(!dimensionScores.size)lines.push('| — | — | 0 |');
  lines.push('',`* Teknik doğrulama: ${technicalPass}/${stepAttempts} geçti. Semantik: ${semanticPass} geçti, ${semanticFail} başarısız, ${ungraded} notlandırılmadı. `+
    'Puanlar kalibre edilmemiştir ve insan incelemesi bekler. Başarılı bir test harness güvenilirliğini veya genellenebilir performans artışını kanıtlamaz.',
    '', '## Öncelikli inceleme maddeleri', '', '| Öncelik | Case | Tekrar | Adım | Sorun ve değerlendirme gerekçesi | Kanıt |', '|---|---|---:|---|---|---|');
  issues.sort((a,b)=>a.priority-b.priority||a.caseId.localeCompare(b.caseId)||a.rep-b.rep||a.step.localeCompare(b.step));
  for(const issue of issues)lines.push(`| P${issue.priority} | ${inline(issue.caseId)} | ${issue.rep} | ${inline(issue.step)} | ${inline(issue.issue)} | ${issue.evidence} |`);
  if(!issues.length)lines.push('| — | — | — | — | İnceleme işareti bulunmadı | — |');
  lines.push('', '## Kaynak ve kapsam', '', `- Suite SHA-256: ${inline(report.suiteHash??'raporda yok')}`, `- Kaynak sürümler: ${inline(report.sourceVersions===undefined?'raporda yok':JSON.stringify(report.sourceVersions))}`, `- Hakem yapılandırması: ${inline(report.judge===undefined?'raporda yok':JSON.stringify(report.judge))}`, `- Bütçe: ${report.budget===undefined?'raporda yok':inline(JSON.stringify(report.budget))}`, `- Kontroller: ${report.checks===undefined?'raporda yok':inline(JSON.stringify(report.checks))}`);
  return lines.join('\n');
}
