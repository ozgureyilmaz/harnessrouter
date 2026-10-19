import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCriteria} from '../../src/verification/criteria.js';

test('criterion evaluation uses verified browser evidence and leaves subjective claims unverified',()=>{
  const results=evaluateCriteria({acceptanceCriteria:[
    'Readable screenshot',
    'Measured palette typography and layout',
    'Observed title and final URL',
    'The screenshot looks polished',
    'Do not include a screenshot',
    'The page feels trustworthy',
  ]},{
    status:'completed',
    structuredOutput:{
      browserToolCalls:2,
      websiteObservations:{
        sourceUrl:'https://example.com/',
        pageTitle:'Example Domain',
        visualStyle:{
          palette:{pageBackground:'rgb(238, 238, 238)',bodyText:'rgb(0, 0, 0)'},
          typography:{bodyFontFamily:'system-ui, sans-serif'},
          layout:{mainContentBox:{width:480}},
        },
      },
    },
    artifacts:[{type:'screenshot',path:'/run/screenshot.png',verified:true,mimeType:'image/png'}],
  });
  assert.deepEqual(results.map(result=>result.status),['passed','passed','passed','unverified','unverified','unverified']);
  assert.equal(results[0]?.evidence,'/run/screenshot.png');
  assert.equal(results[1]?.evidence,'structuredOutput.websiteObservations.visualStyle');
  assert.equal(results[3]?.verifier,'none');
  assert.equal(results[4]?.verifier,'none');
});

test('criterion evaluation requires a measured https link for href checks',()=>{
  const missing=evaluateCriteria({acceptanceCriteria:['Measured href']},{
    status:'completed',
    structuredOutput:{websiteObservations:{sourceUrl:'https://example.com/',pageTitle:'Example',links:[]}},
    artifacts:[],
  });
  assert.equal(missing[0]?.status,'failed');
  const present=evaluateCriteria({acceptanceCriteria:['Measured href']},{
    status:'completed',
    structuredOutput:{websiteObservations:{links:[{text:'Learn more',href:'https://www.iana.org/help/example-domains'}]}},
    artifacts:[],
  });
  assert.equal(present[0]?.status,'passed');
  assert.equal(present[0]?.evidence,'structuredOutput.websiteObservations.links');
});

test('criterion evaluation does not treat agent completion as artifact evidence',()=>{
  const results=evaluateCriteria({acceptanceCriteria:['Readable screenshot']},{
    status:'completed',structuredOutput:{summary:'Screenshot captured'},artifacts:[],
  });
  assert.equal(results[0]?.status,'failed');
  assert.equal(results[0]?.verifier,'artifact');
});

test('criterion evaluation rejects a screenshot marked verified with an unsupported MIME type',()=>{
  const results=evaluateCriteria({acceptanceCriteria:['Readable screenshot']},{
    status:'completed',structuredOutput:{},artifacts:[{type:'screenshot',path:'/run/screenshot.png',verified:true,mimeType:'text/html'}],
  });
  assert.equal(results[0]?.status,'failed');
});

test('criterion evaluation leaves every criterion unverified when execution did not complete',()=>{
  const results=evaluateCriteria({acceptanceCriteria:['Readable screenshot','Task was safe']},{
    status:'failed',structuredOutput:{},artifacts:[],
  });
  assert.deepEqual(results.map(result=>result.status),['unverified','unverified']);
});

test('criterion evaluation verifies decoded image ratio, provider ID, and planner provenance separately',()=>{
  const results=evaluateCriteria({acceptanceCriteria:[
    'Decoded 16:9 image',
    'Actual fal request ID',
    'Observed website style consumed by planner',
    'Image decodes',
    'Image style resembles the source page',
  ]},{
    status:'completed',
    structuredOutput:{
      width:1024,height:576,expectedAspectRatio:16/9,
      parentRunId:'9f372976-bce1-49a4-bdf4-cc1eb68136cf',observationFingerprint:'a'.repeat(64),sourceUrl:'https://example.com/',
      observedFields:['summary descriptors','palette','typography','layout'],
    },
    artifacts:[{type:'image',path:'/run/hero.png',verified:true,mimeType:'image/png',providerRequestId:'fal-request-123'}],
  });
  assert.deepEqual(results.map(result=>result.status),['passed','passed','passed','passed','unverified']);
  assert.deepEqual(results.slice(0,4).map(result=>result.verifier),['artifact','provider_metadata','planner_provenance','artifact']);
});
