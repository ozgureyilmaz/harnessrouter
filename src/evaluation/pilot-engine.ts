import type {HarnessResult} from '../domain/types.js';
import type {PilotCase,PilotStep,PilotSuite} from './pilot-suite.js';

export interface PilotStepOutcome {
  stepId:string; harnessId:string; routeId?:string; status:string;
  technicalPassed:boolean; runId?:string; tracePath?:string; result?:HarnessResult;
  semantic?:{status:string;passed?:boolean;scores?:Array<{dimension:string;score:number;reason?:string;evidence?:string[]}>;[key:string]:unknown};
  reference?:unknown; error?:string; stopReason?:string;
  [key:string]:unknown;
}
export interface PilotTrialOutcome {
  caseId:string;repetition:number;category:string;path:string;environment:string;
  status:'completed'|'failed'|'skipped';steps:PilotStepOutcome[];skipReason?:string;
}
export interface PilotHooks {
  execute:(testCase:PilotCase,step:PilotStep,repetition:number,previous?:PilotStepOutcome)=>Promise<PilotStepOutcome>;
  stopReason:()=>Promise<string|undefined>;
  checkpoint:(rows:PilotTrialOutcome[])=>Promise<void>;
}

/** A resolved failure is a measured trial, never a reason to drop later samples. */
export async function executePilot(suite:PilotSuite,hooks:PilotHooks):Promise<{results:PilotTrialOutcome[];stopReason?:string}> {
  const rows:PilotTrialOutcome[]=[];let halted:string|undefined;
  for(const testCase of suite.cases){
    for(let repetition=1;repetition<=suite.repetitions;repetition++){
      halted??=await hooks.stopReason();
      const row:PilotTrialOutcome={caseId:testCase.id,repetition,category:testCase.category,path:testCase.path,environment:testCase.environment,status:halted?'skipped':'completed',steps:[],...(halted?{skipReason:halted}:{})};
      if(!halted){
        let previous:PilotStepOutcome|undefined;
        for(const step of testCase.steps){
          halted??=await hooks.stopReason();
          const blocked=halted??(step.inheritPreviousObservations&&(!previous?.technicalPassed||previous.status!=='completed')?'upstream_step_failed':undefined);
          if(blocked){row.steps.push({stepId:step.id,harnessId:step.harnessId,routeId:step.routeId,status:'skipped',technicalPassed:false,error:blocked});row.status='failed';continue;}
          const outcome=await hooks.execute(testCase,step,repetition,previous);
          row.steps.push(outcome);previous=outcome;
          if(outcome.stopReason)halted=outcome.stopReason;
          if(outcome.status!=='completed'||!outcome.technicalPassed||outcome.semantic?.status!=='scored'||!outcome.semantic.passed)row.status='failed';
          await hooks.checkpoint([...rows,row]);
        }
      }
      rows.push(row);await hooks.checkpoint(rows);
    }
  }
  return {results:rows,...(halted?{stopReason:halted}:{})};
}
