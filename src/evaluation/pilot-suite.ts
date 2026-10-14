import {z} from 'zod';
import {validateTask} from '../domain/schemas.js';
import type {HarnessTask} from '../domain/types.js';

const taskSchema = z.custom<HarnessTask>((value) => {
  try { validateTask(value); return true; } catch { return false; }
}, 'Expected a valid HarnessTask v1.0');

export const PilotStepSchema = z.object({
  id:z.string().min(1),
  harnessId:z.enum(['pi-browser','fal-creative']),
  routeId:z.string().min(1).optional(),
  task:taskSchema,
  fixtureId:z.enum(['simple','layout','long','injection']).optional(),
  expectedFacts:z.array(z.string().min(1)),
  dimensions:z.array(z.string().min(1)).min(1),
  inheritPreviousObservations:z.boolean().optional(),
}).strict();

export const PilotCaseSchema = z.object({
  id:z.string().min(1),
  category:z.enum(['browser','image','composed']),
  path:z.enum(['direct','router']),
  environment:z.enum(['controlled','public','generated']),
  steps:z.array(PilotStepSchema).min(1),
}).strict();

export const PilotSuiteSchema = z.object({
  schemaVersion:z.literal('1.1'),
  id:z.string().min(1),
  repetitions:z.number().int().positive(),
  cases:z.array(PilotCaseSchema).min(1),
}).strict().superRefine((suite,ctx)=>{
  const caseIds=new Set<string>();
  for (const item of suite.cases) {
    if(caseIds.has(item.id)) ctx.addIssue({code:'custom',path:['cases'],message:`Duplicate case id: ${item.id}`});
    caseIds.add(item.id);
    const stepIds=new Set<string>();
    for(const step of item.steps){
      if(stepIds.has(step.id)) ctx.addIssue({code:'custom',path:['cases',item.id,'steps'],message:`Duplicate step id: ${step.id}`});
      stepIds.add(step.id);
      if(step.harnessId==='pi-browser'&&step.fixtureId===undefined&&step.task.context?.url===undefined) ctx.addIssue({code:'custom',path:['cases',item.id,'steps',step.id],message:'Browser step needs a fixture or context URL'});
      if(step.inheritPreviousObservations&&item.path!=='router') ctx.addIssue({code:'custom',path:['cases',item.id,'steps',step.id],message:'Observation inheritance is reserved for composed router workflows'});
    }
  }
});

export type PilotStep=z.infer<typeof PilotStepSchema>;
export type PilotCase=z.infer<typeof PilotCaseSchema>;
export type PilotSuite=z.infer<typeof PilotSuiteSchema>;

export function parsePilotSuite(value:unknown):PilotSuite{return PilotSuiteSchema.parse(value);}
