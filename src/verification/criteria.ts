import type {Artifact, CriterionResult, HarnessResult, HarnessTask} from '../domain/types.js';

type CriterionEvidence = Pick<HarnessResult, 'status'|'structuredOutput'|'artifacts'>;

export function unverifiedCriteria(criteria: readonly string[]): CriterionResult[] {
  return criteria.map(criterion => ({criterion,status:'unverified',verifier:'none'}));
}

export function evaluateCriteria(task: Pick<HarnessTask,'acceptanceCriteria'>, result: CriterionEvidence): CriterionResult[] {
  if (result.status !== 'completed') return unverifiedCriteria(task.acceptanceCriteria);
  return task.acceptanceCriteria.map(criterion => evaluateCriterion(criterion,result));
}

function evaluateCriterion(criterion: string, result: CriterionEvidence): CriterionResult {
  const lower=criterion.toLowerCase();
  const observations=result.structuredOutput?.websiteObservations as Record<string,unknown>|undefined;
  const artifacts=result.artifacts;

  if (/^patch applies to (?:the )?captured baseline\.?$/.test(lower)) {
    const patch=artifacts.find(item=>item.type==='patch'&&item.verified&&item.path);
    const metadata=result.structuredOutput?.patch as {sha256?:unknown;baselineFingerprint?:unknown}|undefined;
    const passed=!!patch&&typeof metadata?.sha256==='string'&&typeof metadata.baselineFingerprint==='string';
    return {criterion,status:passed?'passed':'failed',verifier:'artifact',...(passed?{evidence:patch!.path}: {})};
  }
  if (/^readable text answer\.?$/.test(lower)) {
    const text=artifacts.find(item=>item.type==='text'&&item.verified&&item.path);
    return {criterion,status:text?'passed':'failed',verifier:'artifact',...(text?{evidence:text.path}: {})};
  }
  // Negated criteria need semantic evaluation that the deterministic verifier does not provide.
  if (/\b(?:not|never|without|avoid|no)\b/.test(lower)) return {criterion,status:'unverified',verifier:'none'};

  if (/\b(?:readable|decodable|decoded|verified|actual)\b.*\bscreenshot\b|\bscreenshot\b.*\b(?:exists|captured|saved|readable|decoded)\b/.test(lower)) {
    const artifact=artifacts.find(item=>item.type==='screenshot');
    return fromArtifact(criterion,artifact);
  }
  if (/\b(?:actual\s+)?(?:pi\s+)?browser navigation\b/.test(lower)) {
    const sourceUrl=observations?.sourceUrl;
    const calls=result.structuredOutput?.browserToolCalls;
    return {
      criterion,status:typeof sourceUrl==='string'&&sourceUrl.length>0&&typeof calls==='number'&&calls>0?'passed':'failed',
      verifier:'browser_observation',...(typeof sourceUrl==='string'&&sourceUrl.length>0?{evidence:'structuredOutput.websiteObservations.sourceUrl'}:{}),
    };
  }
  if (/\b(?:exact link target|measured href|link href)\b/.test(lower)) {
    const links=observations?.links;
    const valid=Array.isArray(links)&&links.some(link=>isObject(link)&&typeof link.href==='string'&&link.href.startsWith('https://')&&typeof link.text==='string'&&link.text.length>0);
    return {criterion,status:valid?'passed':'failed',verifier:'browser_observation',...(valid?{evidence:'structuredOutput.websiteObservations.links'}:{})};
  }
  if (/\b(?:observed title and final url|page title and final url)\b/.test(lower)) {
    const hasEvidence=typeof observations?.sourceUrl==='string'&&typeof observations.pageTitle==='string'&&observations.pageTitle.length>0;
    return {criterion,status:hasEvidence?'passed':'failed',verifier:'browser_observation',...(hasEvidence?{evidence:'structuredOutput.websiteObservations.sourceUrl,pageTitle'}:{})};
  }
  if (/\bmeasured\b/.test(lower)&&/\bpalette\b/.test(lower)&&/\btypography\b/.test(lower)&&/\blayout\b/.test(lower)) {
    const style=observations?.visualStyle as Record<string,unknown>|undefined;
    const hasEvidence=!!style&&hasMeaningfulEvidence(style.palette)&&hasMeaningfulEvidence(style.typography)&&hasMeaningfulEvidence(style.layout);
    return {criterion,status:hasEvidence?'passed':'failed',verifier:'browser_observation',...(hasEvidence?{evidence:'structuredOutput.websiteObservations.visualStyle'}:{})};
  }
  if (/\b(?:structured|measured)\b.*\b(?:visual\s+)?style\s+observations\b/.test(lower)) {
    const style=observations?.visualStyle;
    const hasEvidence=isObject(style)&&hasMeaningfulEvidence(style);
    return {criterion,status:hasEvidence?'passed':'failed',verifier:'browser_observation',...(hasEvidence?{evidence:'structuredOutput.websiteObservations.visualStyle'}:{})};
  }
  if (/\bfal request id\b/.test(lower)) {
    const image=artifacts.find(item=>item.type==='image');
    const requestId=result.structuredOutput?.providerRequestId??image?.providerRequestId;
    const valid=typeof requestId==='string'&&requestId.length>0&&!!image?.verified;
    return {criterion,status:valid?'passed':'failed',verifier:'provider_metadata',...(valid?{evidence:`artifact.providerRequestId=${requestId}`}:{})};
  }
  if (/\b(?:provider|fal) request id\b/.test(lower)) {
    const requestId=result.structuredOutput?.providerRequestId??artifacts.find(item=>item.type==='image')?.providerRequestId;
    const artifact=artifacts.find(item=>item.type==='image'&&item.verified&&typeof item.path==='string');
    const valid=typeof requestId==='string'&&requestId.length>0&&!!artifact;
    return {criterion,status:valid?'passed':'failed',verifier:'provider_metadata',...(valid?{evidence:`structuredOutput.providerRequestId; ${artifact!.path}`}:{})};
  }
  if (/\bimage\s+(?:decodes|decoded|is decodable)\b/.test(lower)) {
    return fromArtifact(criterion,artifacts.find(item=>item.type==='image'));
  }
  if (/\b16:9\b/.test(lower)) {
    const image=artifacts.find(item=>item.type==='image');
    const width=result.structuredOutput?.width;
    const height=result.structuredOutput?.height;
    const ratio=result.structuredOutput?.expectedAspectRatio;
    const measured=typeof width==='number'&&typeof height==='number'&&height>0?width/height:undefined;
    const valid=!!image?.verified&&typeof image.path==='string'&&isSupportedImageMime(image.mimeType)&&measured!==undefined&&typeof ratio==='number'&&Math.abs(measured-ratio)<=0.025&&Math.abs(ratio-16/9)<=0.025;
    return {criterion,status:valid?'passed':'failed',verifier:'artifact',...(valid&&image?.path?{evidence:image.path}:{})};
  }
  if (/\bobserved website style consumed by planner\b/.test(lower)) {
    const output=result.structuredOutput;
    const parentRunId=output?.parentRunId;
    const observationFingerprint=output?.observationFingerprint;
    const sourceUrl=output?.sourceUrl;
    const observedFields=output?.observedFields;
    const valid=typeof parentRunId==='string'&&/^[a-f0-9-]{36}$/i.test(parentRunId)
      &&typeof observationFingerprint==='string'&&/^[a-f0-9]{64}$/i.test(observationFingerprint)
      &&typeof sourceUrl==='string'&&sourceUrl.startsWith('https://')
      &&Array.isArray(observedFields)&&['palette','typography','layout'].every(field=>observedFields.includes(field));
    return {criterion,status:valid?'passed':'failed',verifier:'planner_provenance',...(valid?{evidence:`parentRunId=${parentRunId}; observationFingerprint=${observationFingerprint}; observedFields=palette,typography,layout`}:{})};
  }
  return {criterion,status:'unverified',verifier:'none'};
}

function fromArtifact(criterion:string,artifact:Artifact|undefined):CriterionResult {
  const valid=!!artifact?.verified&&typeof artifact.path==='string'&&isSupportedImageMime(artifact.mimeType);
  return {criterion,status:valid?'passed':'failed',verifier:'artifact',...(valid?{evidence:artifact.path}:{})};
}

function isSupportedImageMime(value:unknown):value is string {
  return value==='image/png'||value==='image/jpeg'||value==='image/webp';
}

function hasMeaningfulEvidence(value:unknown):boolean {
  if(typeof value==='string')return value.trim().length>0;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.some(hasMeaningfulEvidence);
  if(isObject(value))return Object.values(value).some(hasMeaningfulEvidence);
  return false;
}

function isObject(value:unknown):value is Record<string,unknown> {
  return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
