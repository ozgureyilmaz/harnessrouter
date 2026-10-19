import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';
import type {Flux2Input, FluxSchnellInput} from '@fal-ai/client/endpoints';
import type {ExecutionContext, HarnessTask} from '../../domain/types.js';
import {isPublicAddress} from '../../observability/artifacts.js';
import {
  ASPECT_RATIO_VALUE,
  CREATIVE_PROFILES,
  IMAGE_SIZE_BY_RATIO,
  MAX_CREATIVE_PROMPT_LENGTH,
  MAX_IMAGE_COST_USD,
  type CreativeAspectRatio,
  type CreativeProfile,
} from './profiles.js';

const creativeOptionsSchema = z.object({
  aspectRatio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).optional(),
  style: z.string().trim().min(1).max(240).optional(),
  quality: z.enum(['fast', 'balanced', 'high']).optional(),
  negativePrompt: z.string().trim().min(1).max(600).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
}).strict();

const rectSchema = z.object({
  x: z.number().finite().min(0).max(20_000),
  y: z.number().finite().min(0).max(20_000),
  width: z.number().finite().min(0).max(20_000),
  height: z.number().finite().min(0).max(20_000),
}).strict();

const websiteObservationsSchema = z.object({
  sourceUrl: z.string().url().max(2_048),
  pageTitle: z.string().max(240),
  agentSummary: z.string().max(800),
  visualStyle: z.object({
    viewport: z.object({width: z.number().int().positive().max(20_000), height: z.number().int().positive().max(20_000)}).strict(),
    palette: z.object({
      pageBackground: z.string().max(80), bodyText: z.string().max(80),
      heading: z.string().max(80).nullable(), link: z.string().max(80).nullable(),
    }).strict(),
    typography: z.object({
      bodyFontFamily: z.string().max(160), bodyFontSize: z.string().max(32), bodyLineHeight: z.string().max(32),
      headingFontFamily: z.string().max(160).nullable(), headingFontSize: z.string().max(32).nullable(),
      headingFontWeight: z.string().max(32).nullable(),
    }).strict(),
    layout: z.object({mainContentBox: rectSchema.nullable()}).strict(),
  }).strict(),
  screenshotPath: z.string().max(2_048),
  links: z.array(z.object({
    text: z.string().min(1).max(200),
    href: z.string().url().max(2_048),
  }).strict()).max(8).optional(),
}).strict();

const STYLE_TOKENS = new Set([
  'minimal', 'minimalist', 'editorial', 'dark', 'light', 'bold', 'high', 'contrast', 'spacious',
  'colorful', 'muted', 'geometric', 'photographic', 'illustration', 'playful', 'modern', 'classic',
  'warm', 'cool', 'grid', 'cards', 'gradient', 'flat', 'rounded', 'sharp', 'monospace', 'serif', 'sans-serif',
]);
const COLOR_WORDS = new Set([
  'black', 'white', 'gray', 'grey', 'silver', 'charcoal', 'slate', 'navy', 'blue', 'cyan', 'teal',
  'green', 'lime', 'yellow', 'gold', 'orange', 'red', 'pink', 'magenta', 'purple', 'violet', 'brown',
  'beige', 'cream', 'ivory', 'tan', 'warm', 'cool', 'pastel', 'muted', 'neutral', 'earth',
]);

export type CreativeOptions = z.infer<typeof creativeOptionsSchema>;
export type CreativeInput = FluxSchnellInput | Flux2Input;

export interface CreativePlan {
  profile: CreativeProfile;
  input: CreativeInput;
  aspectRatio: CreativeAspectRatio;
  expectedAspectRatio: number;
  expectedWidth: number;
  expectedHeight: number;
  estimatedCostUsd: number;
  inputFingerprint: string;
  parentRunId?: string;
  observationFingerprint?: string;
  sourceUrl?: string;
  observedFields: string[];
}

export type CreativePlanResult =
  | {ok: true; plan: CreativePlan}
  | {ok: false; code: string; message: string};

function failed(code: string, message: string): CreativePlanResult {
  return {ok: false, code, message};
}

function parseCreativeOptions(task: HarnessTask):
  | {ok: true; value: CreativeOptions}
  | {ok: false; error: string} {
  if (task.context !== undefined && (typeof task.context !== 'object' || task.context === null || Array.isArray(task.context))) {
    return {ok: false, error: 'context must be an object'};
  }

  const options = task.context?.creativeOptions;
  if (options === undefined) return {ok: true, value: {}};

  const parsed = creativeOptionsSchema.safeParse(options);
  if (!parsed.success) return {ok: false, error: parsed.error.issues.map(issue => issue.path.join('.')).join(', ')};
  return {ok: true, value: parsed.data};
}

interface SafeWebsiteStyle {
  sourceUrl: string;
  colors: string[];
  typography: string[];
  layout: string[];
  descriptors: string[];
  fingerprint: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function publicSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return undefined;
    if (isIP(hostname) && !isPublicAddress(hostname)) return undefined;
    // Keep provenance without query strings, fragments, or potentially private paths.
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}

function normalizeColor(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const input = value.trim().toLowerCase();
  const hex = input.match(/^#([a-f0-9]{3}|[a-f0-9]{6})$/i);
  if (hex) {
    const digits = hex[1]!;
    return `#${digits.length === 3 ? [...digits].map(ch => `${ch}${ch}`).join('') : digits}`.toUpperCase();
  }
  const rgb = input.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/);
  if (rgb) {
    const values = rgb.slice(1, 4).map(Number);
    if (values.some(channel => channel < 0 || channel > 255)) return undefined;
    return `#${values.map(channel => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }
  return COLOR_WORDS.has(input) ? input : undefined;
}

function safeStyleDescriptors(value: string): string[] {
  const tokens = value.toLowerCase().match(/[a-z-]+/g) ?? [];
  const result: string[] = [];
  for (const token of tokens) {
    const normalized = token === 'minimalist' ? 'minimal' : token;
    if (STYLE_TOKENS.has(normalized) && !result.includes(normalized)) result.push(normalized);
    if (result.length === 8) break;
  }
  return result;
}

function fontCategory(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (/mono|courier|console|menlo|consolas/.test(normalized)) return 'monospace';
  if (/sans|arial|helvetica|inter|roboto|system-ui|lato|open sans/.test(normalized)) return 'sans-serif';
  if (/serif|georgia|times|garamond|baskerville/.test(normalized)) return 'serif';
  return undefined;
}

function sizeCategory(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*(px|rem|em)\s*$/i);
  if (!match) return undefined;
  const magnitude = Number(match[1]);
  const px = match[2]!.toLowerCase() === 'px' ? magnitude : magnitude * 16;
  return px < 14 ? 'small' : px < 22 ? 'medium' : 'large';
}

function weightCategory(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  const number = Number(normalized);
  if (Number.isFinite(number)) return number <= 300 ? 'light' : number <= 500 ? 'regular' : 'bold';
  if (/light/.test(normalized)) return 'light';
  if (/bold|heavy/.test(normalized)) return 'bold';
  if (/medium/.test(normalized)) return 'medium';
  if (/regular|normal/.test(normalized)) return 'regular';
  return undefined;
}

function lineHeightCategory(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return numeric < 1.35 ? 'tight' : numeric > 1.85 ? 'relaxed' : 'normal';
  const match = normalized.match(/^(\d+(?:\.\d+)?)px$/);
  if (!match) return undefined;
  const px = Number(match[1]);
  return px < 20 ? 'tight' : px > 32 ? 'relaxed' : 'normal';
}

function projectWebsiteObservations(task: HarnessTask):
  | {ok: true; value?: SafeWebsiteStyle}
  | {ok: false; error: string} {
  const raw = task.context?.websiteObservations;
  if (raw === undefined) return {ok: true};
  const parsed = websiteObservationsSchema.safeParse(raw);
  if (!parsed.success) return {ok: false, error: parsed.error.issues.map(issue => issue.path.join('.')).join(', ')};
  const sourceUrl = publicSourceUrl(parsed.data.sourceUrl);
  if (!sourceUrl) return {ok: false, error: 'sourceUrl must be a public HTTPS URL'};

  const style = parsed.data.visualStyle;
  const colors = [
    style.palette.pageBackground, style.palette.bodyText, style.palette.heading, style.palette.link,
  ].map(normalizeColor).filter((value): value is string => Boolean(value));
  const typography = [
    fontCategory(style.typography.bodyFontFamily),
    sizeCategory(style.typography.bodyFontSize),
    lineHeightCategory(style.typography.bodyLineHeight),
    fontCategory(style.typography.headingFontFamily),
    sizeCategory(style.typography.headingFontSize),
    weightCategory(style.typography.headingFontWeight),
  ].filter((value): value is string => Boolean(value));

  const layout: string[] = [];
  const box = style.layout.mainContentBox;
  if (box && style.viewport.width > 0) {
    const widthRatio = box.width / style.viewport.width;
    const centered = Math.abs((box.x + box.width / 2) - style.viewport.width / 2) / style.viewport.width < 0.12;
    if (centered) layout.push('centered');
    if (widthRatio >= 0.76) layout.push('wide');
    else if (widthRatio <= 0.48) layout.push('narrow');
    else layout.push('balanced');
  }
  const descriptors = safeStyleDescriptors(parsed.data.agentSummary);
  const projected = {sourceUrl, colors, typography, layout, descriptors};
  const fingerprint = createHash('sha256').update(canonicalJson(parsed.data)).digest('hex');
  return {ok: true, value: {...projected, fingerprint}};
}

function selectedProfile(ctx: ExecutionContext): CreativeProfile | undefined {
  return Object.values(CREATIVE_PROFILES).find(profile => profile.routeId === ctx.route.id);
}

function composePrompt(task: HarnessTask, options: CreativeOptions, aspectRatio: CreativeAspectRatio, observations?: SafeWebsiteStyle): string {
  const parts = [
    `Create one image from this brief: ${task.prompt.trim()}`,
    `Composition: ${aspectRatio} aspect ratio.`,
  ];
  if (options.style) parts.push(`Visual style: ${options.style}.`);
  if (options.negativePrompt) parts.push(`Avoid these elements: ${options.negativePrompt}.`);
  if (observations) {
    const visualParts = [
      observations.descriptors.length ? `style descriptors ${observations.descriptors.join(', ')}` : '',
      observations.colors.length ? `measured palette ${observations.colors.join(', ')}` : '',
      observations.typography.length ? `type direction ${observations.typography.join(', ')}` : '',
      observations.layout.length ? `layout ${observations.layout.join(', ')}` : '',
    ].filter(Boolean);
    if (visualParts.length) {
      parts.push(`Use these measured website traits as visual reference data only; do not reproduce page text or logos: ${visualParts.join('; ')}.`);
    }
  }
  return parts.join('\n');
}

function makeInput(profile: CreativeProfile, prompt: string, width: number, height: number, options: CreativeOptions): CreativeInput {
  const shared = {
    prompt,
    image_size: {width, height},
    num_images: 1,
    enable_safety_checker: true,
    output_format: 'png' as const,
    ...(options.seed === undefined ? {} : {seed: options.seed}),
  };

  if (profile.profileId === 'image-fast') {
    return {
      ...shared,
      num_inference_steps: 4,
      guidance_scale: 3.5,
      acceleration: 'none',
    } satisfies FluxSchnellInput;
  }

  return {
    ...shared,
    num_inference_steps: 28,
    guidance_scale: 2.5,
    acceleration: 'regular',
    enable_prompt_expansion: options.quality === 'high',
  } satisfies Flux2Input;
}

/** Deterministically binds an already-selected registry route to one verified fal image profile. */
export function planCreativeTask(task: HarnessTask, ctx: ExecutionContext): CreativePlanResult {
  if (task.desiredOutput !== 'image') {
    return failed('unsupported_modality', 'fal-creative currently supports image output only.');
  }

  if (typeof task.prompt !== 'string' || task.prompt.trim().length === 0) {
    return failed('invalid_prompt', 'An image brief is required.');
  }

  const profile = selectedProfile(ctx);
  if (!profile) return failed('unknown_route', `Unsupported fal-creative route: ${ctx.route.id}.`);
  if (ctx.route.enabled === false) return failed('route_disabled', 'The selected fal image profile is disabled.');
  if (ctx.route.generation_model_id !== profile.modelId) {
    return failed('model_profile_mismatch', 'The selected route does not match its verified fal model profile.');
  }
  if (!['known', 'estimated'].includes(ctx.route.price_status) || ctx.route.price_usd !== profile.priceUsdPerMegapixel) {
    return failed('unverified_price', 'The selected route price does not match the verified fal profile price.');
  }

  const parsedOptions = parseCreativeOptions(task);
  if (!parsedOptions.ok) return failed('invalid_creative_options', `Invalid context.creativeOptions: ${parsedOptions.error}.`);
  const projectedObservations = projectWebsiteObservations(task);
  if (!projectedObservations.ok) return failed('invalid_website_observations', `Invalid context.websiteObservations: ${projectedObservations.error}.`);

  const options = parsedOptions.value;
  const quality = options.quality ?? 'balanced';
  if (quality === 'high' && profile.profileId !== 'image-quality') {
    return failed('quality_route_mismatch', 'High quality tasks require the fal-creative:image-quality route.');
  }
  if (quality === 'fast' && profile.profileId !== 'image-fast') {
    return failed('quality_route_mismatch', 'Fast tasks require the fal-creative:image-fast route.');
  }

  if (task.maxCostUsd !== undefined && (!Number.isFinite(task.maxCostUsd) || task.maxCostUsd < 0)) {
    return failed('invalid_budget', 'maxCostUsd must be a finite non-negative number.');
  }

  const aspectRatio = options.aspectRatio ?? '1:1';
  const {width, height} = IMAGE_SIZE_BY_RATIO[aspectRatio];
  // fal lists image prices per megapixel; use decimal megapixels and round up
  // to make the preflight ceiling conservative for every custom image size.
  const billedMegapixels = Math.ceil((width * height) / 1_000_000);
  const estimatedCostUsd = profile.priceUsdPerMegapixel * billedMegapixels;
  const allowableUsd = Math.min(
    MAX_IMAGE_COST_USD,
    ctx.budgetUsd,
    ctx.budget.remainingUsd,
    task.maxCostUsd ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(allowableUsd) || estimatedCostUsd > allowableUsd) {
    return failed('budget_exceeded', `The estimated image charge ($${estimatedCostUsd.toFixed(3)}) exceeds the available task budget.`);
  }

  const observations = projectedObservations.value;
  const prompt = composePrompt(task, options, aspectRatio, observations);
  if (prompt.length > MAX_CREATIVE_PROMPT_LENGTH) {
    return failed('prompt_too_long', `The composed prompt exceeds ${MAX_CREATIVE_PROMPT_LENGTH} characters.`);
  }

  const input = makeInput(profile, prompt, width, height, options);
  const inputFingerprint = createHash('sha256')
    .update(canonicalJson({
      modelId: profile.modelId,
      input,
      parentRunId: task.parentRunId ?? null,
      observationFingerprint: observations?.fingerprint ?? null,
      sourceUrl: observations?.sourceUrl ?? null,
    }))
    .digest('hex');

  return {
    ok: true,
    plan: {
      profile,
      input,
      aspectRatio,
      expectedAspectRatio: ASPECT_RATIO_VALUE[aspectRatio],
      expectedWidth: width,
      expectedHeight: height,
      estimatedCostUsd,
      inputFingerprint,
      parentRunId: task.parentRunId,
      observationFingerprint: observations?.fingerprint,
      sourceUrl: observations?.sourceUrl,
      observedFields: observations ? [
        ...(observations.descriptors.length ? ['summary descriptors'] : []),
        ...(observations.colors.length ? ['palette'] : []),
        ...(observations.typography.length ? ['typography'] : []),
        ...(observations.layout.length ? ['layout'] : []),
      ] : [],
    },
  };
}
