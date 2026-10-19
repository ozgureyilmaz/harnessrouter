import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {loadConfig} from '../src/config.js';
import {verifyImage} from '../src/observability/artifacts.js';
const config=loadConfig();const directory=join(config.artifactsDir,'paired-agentation-2026-10-12');
const read=async(file:string)=>JSON.parse(await readFile(join(directory,file),'utf8'));
const directBrowser=await read('direct-browser.json');const routedBrowserRecord=await read('routed-browser.json');const routedBrowser=routedBrowserRecord.data;
const directImage=await read('direct-workflow-image.json');const routedImage=(await read('routed-workflow-image.json')).data;const matchedImage=await read('direct-matched-image.json');const matchedInput=await read('matched-input-evidence.json');
const pixelHash=async(path:string)=>createHash('sha256').update(await sharp(path).removeAlpha().raw().toBuffer()).digest('hex');
const assets=await Promise.all([
  verifyImage(directBrowser.screenshotPath),verifyImage(routedBrowser.artifacts[0].path),
  verifyImage(directImage.artifact.path,{expectedRatio:16/9}),verifyImage(routedImage.artifacts[0].path,{expectedRatio:16/9}),verifyImage(matchedImage.artifact.path,{expectedRatio:16/9})
]);
if(matchedInput.plainInputSha256!==matchedImage.inputSha256)throw new Error('Matched direct input differs from captured routed input');
const [routedPixels,matchedPixels]=await Promise.all([pixelHash(routedImage.artifacts[0].path),pixelHash(matchedImage.artifact.path)]);
const directStyle=directBrowser.observation.visualStyle;const routedStyle=routedBrowser.structuredOutput.websiteObservations.visualStyle;
const same=(a:unknown,b:unknown)=>JSON.stringify(Object.entries(a as Record<string,unknown>).sort())===JSON.stringify(Object.entries(b as Record<string,unknown>).sort());
const budget=JSON.parse(await readFile(join(config.artifactsDir,'budget.json'),'utf8'));
const report={schemaVersion:'1.0',date:'2026-10-12',url:'https://www.agentation.com/',design:'One public-browser pair, one full-workflow image pair, one exact-input direct fal control. Pilot only; no statistical efficiency claim.',
  controls:{imageModel:'fal-ai/flux-2',imageWidth:1024,imageHeight:576,seed:4242,steps:28,guidanceScale:2.5,acceleration:'regular',promptExpansion:true,numImages:1,safetyChecker:true,browserViewport:{width:1280,height:720}},
  browser:{direct:{...directBrowser,observation:{pageTitle:directBrowser.observation.pageTitle,headline:directBrowser.observation.headline,visualStyle:directStyle},rawEvidence:'direct-browser.json'},routed:{runId:routedBrowser.runId,status:routedBrowser.status,timing:routedBrowser.timing,mcpRoundtripMs:routedBrowserRecord.toolRoundtripMs,usage:routedBrowser.usage,costComponents:routedBrowser.costComponents,observation:routedBrowser.structuredOutput.websiteObservations,transport:routedBrowserRecord.transport},
    measuredStyleAgreement:{sameTitle:directBrowser.observation.pageTitle===routedBrowser.structuredOutput.websiteObservations.pageTitle,samePalette:same(directStyle.palette,routedStyle.palette),sameTypography:same(directStyle.typography,routedStyle.typography),mainBoxHeightDifferencePx:Math.abs(directStyle.layout.mainContentBox.height-routedStyle.layout.mainContentBox.height)},
    timingComparison:'Direct tool-active time excludes Codex thought/tool gaps. Routed total includes Decisions, Pi model turns, process startup and verifier. Do not calculate a browser speedup from these unlike boundaries.'},
  fullWorkflowImage:{direct:directImage,routed:{runId:routedImage.runId,status:routedImage.status,timing:routedImage.timing,cost:routedImage.cost,costComponents:routedImage.costComponents,artifact:routedImage.artifacts[0],observationFingerprint:routedImage.structuredOutput.observationFingerprint,parentRunId:routedImage.structuredOutput.parentRunId},
    seconds:{direct:directImage.timing.totalMs/1000,routed:routedImage.timing.totalMs/1000},sameHighLevelBrief:true,exactPromptEqual:false,providerQueueConfounded:true,humanBlindQualityScore:null},
  matchedGeneration:{referenceRoutedRunId:routedImage.runId,directControl:matchedImage,exactModelInputVerified:true,inputSha256:matchedInput.plainInputSha256,seconds:{routed:routedImage.timing.totalMs/1000,direct:matchedImage.timing.totalMs/1000},decodedPixelsIdentical:routedPixels===matchedPixels,routedPixelSha256:routedPixels,directPixelSha256:matchedPixels,limits:'Same input and seed yielded different pixels. Provider nondeterminism and enabled prompt expansion may contribute; cause not isolated. One sequential pair cannot attribute latency difference to the harness.'},
  technicalVerification:{decodedArtifacts:assets.length,failedArtifacts:0,generatedImages:3,readableScreenshots:2,allGeneratedImages1024x576:assets.slice(2).every(a=>a.width===1024&&a.height===576),directThinSdkSubmissions:directImage.submissions+matchedImage.submissions},
  cost:{experimentPublishedRateEstimateUsd:directImage.cost.usd+routedImage.cost.usd+matchedImage.cost.usd+(routedBrowser.costComponents?.find((c:{provider:string})=>c.provider==='openai')?.usd??0),completeWorkflowUsd:'unknown: host Codex and Pi OAuth USD accounting unavailable',approvedSessionCapUsd:config.sessionUsd,sessionCommittedUpperBoundUsd:budget.committedUsd,sessionRemainingByLedgerUsd:Math.max(0,config.sessionUsd-budget.committedUsd)},
  limitations:['One measured trial per condition; no statistical test','Full workflow changes harness, agent model, browser surface and prompting together','A preliminary visit preceded an interrupted turn; excluded from trial rows. Browser cache/fresh-context equivalence was not established.','Direct CUA browser durations use Date.now wall-clock measurements; routed/SDK durations use performance.now monotonic measurements.','Direct current Codex model/token usage/USD not independently observed; project requests gpt-6.1-sol/high','Pi used openai-codex/gpt-5.5, with provider-reported usage','First trial order: direct browser then routed; direct full-workflow image then routed; matched direct follows routed','CLI instrumentation setup and host waiting excluded from generation timer; direct browser wall gaps reported separately','Artifacts were inspected with source labels; no claim of blind quality grading','Read-only public site access; scoped www.agentation.com allowlist restored to example.com'],
  evidence:{root:directory,directBrowserScreenshot:directBrowser.screenshotPath,routedBrowserScreenshot:routedBrowser.artifacts[0].path,directWorkflowImage:directImage.artifact.path,routedWorkflowImage:routedImage.artifacts[0].path,matchedDirectImage:matchedImage.artifact.path}};
const out=join(config.root,'artifacts/paired-agentation-comparison.json');await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2));
const f=(v:number)=>(v/1000).toFixed(2);
const markdown=`# Agentation canlı karşılaştırması — 2026-10-12

Bu rapor aynı Codex sohbetinde yürütülen gerçek sağlayıcı ve tarayıcı işlerini karşılaştırır. Site: https://www.agentation.com/. Her koşulda yeni işler gönderildi; eski kayıtlı sonuçlar kullanılmadı.

| Ölçüm | Doğrudan Codex | harnessrouter |
|---|---:|---:|
| Tarayıcı araçlarının aktif süresi | ${f(directBrowser.timing.toolActiveSumMs)} sn | Eşdeğer sınır ölçülmedi |
| Tarayıcı toplam delegasyon süresi | Codex düşünme süresi ayrıştırılamadı | ${f(routedBrowser.timing.totalMs)} sn |
| Görsel üretimi: aynı brief, farklı prompt hazırlığı | ${f(directImage.timing.totalMs)} sn | ${f(routedImage.timing.totalMs)} sn |
| Birebir model girdisiyle ek kontrol | ${f(matchedImage.timing.totalMs)} sn | ${f(routedImage.timing.totalMs)} sn |
| Görsel başına yayımlanmış fiyat tahmini | $0.012 | $${routedImage.cost.usd.toFixed(7)} (Decisions dahil) |
| PNG / 1024×576 doğrulaması | Geçti | Geçti |

**Tarayıcı sonucu:** iki yol aynı başlığı, paleti ve tipografiyi ölçtü. Ana içerik kutusunda ${report.browser.measuredStyleAgreement.mainBoxHeightDifferencePx} piksel yükseklik farkı var. Pi üç tarayıcı aracı çağırdı. Doğrudan araç süresi Codex düşünme aralıklarını içermediği için tablodan bir tarayıcı hız kazancı çıkarılamaz. Önceki kesilen turdaki ilk ziyaret zamanlanan denemeden çıkarıldı; tarayıcı cache/bağlam eşitliği kanıtlanmadı.

**Görsel sonucu:** aynı genel brief ile yönlendirilmiş üretim daha kısa sürdü; birebir model girdisi verilen kontrol çağrısında doğrudan üretim daha kısa sürdü. Sıra/kuyruk/GPU ve indirme değişkenleri tek denemede ayrıştırılamıyor. Bu veri genel bir hız üstünlüğü göstermiyor. Aynı seed ve birebir girdiye rağmen piksel hash'leri farklı; sağlayıcı davranışı deterministik varsayılmadı.

**Maliyet:** bu yeni deneyin yayımlanmış fiyatlara dayanan toplam tahmini $${report.cost.experimentPublishedRateEstimateUsd.toFixed(7)}. Tam maliyet bilinmiyor: Codex ve Pi OAuth dolar maliyeti ölçülemedi. Oturum ledger'ında $${budget.committedUsd.toFixed(3)} / $${config.sessionUsd.toFixed(2)} taahhüt var. Gerçek faturayla eşit sayılmamalı.

**Kabul doğrulaması:** iki gerçek screenshot ve üç gerçek görsel decode edildi. Üç görsel de 1024×576. Tarayıcı başlığı/stili iki bağımsız yolun ölçümleriyle karşılaştırıldı. Sanatsal kalite için kör insan puanı henüz yok; önceki çıktılar kaynak etiketlerini içeriyordu.

## Doğrudan Codex görseli
![Doğrudan Codex](${directImage.artifact.path})

## harnessrouter görseli
![harnessrouter](${routedImage.artifacts[0].path})

## Birebir girdiyle doğrudan kontrol
![Birebir girdi kontrolü](${matchedImage.artifact.path})

Ham sonuçlar: [paired-agentation-comparison.json](${out}). Her işin run ID, provider request ID, zamanlama, hash ve trace yolu JSON'da bulunur. Browser izin kapsamı deney sonrasında example.com'a geri döndürüldü.
`;
await writeFile(join(config.root,'artifacts/paired-agentation-comparison.md'),markdown);console.log(JSON.stringify({report:out,browserAgreement:report.browser.measuredStyleAgreement,imageSeconds:report.fullWorkflowImage.seconds,matchedSeconds:report.matchedGeneration.seconds,verification:report.technicalVerification,cost:report.cost},null,2));
