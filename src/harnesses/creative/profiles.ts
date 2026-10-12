export const CREATIVE_PROFILES = {
  fast: {
    profileId: 'image-fast',
    routeId: 'fal-creative:image-fast',
    modelId: 'fal-ai/flux/schnell',
    label: 'FLUX.1 [schnell]',
    priceUsdPerMegapixel: 0.003,
    source: 'https://fal.ai/models/fal-ai/flux/schnell',
  },
  quality: {
    profileId: 'image-quality',
    routeId: 'fal-creative:image-quality',
    modelId: 'fal-ai/flux-2',
    label: 'FLUX.2 [dev]',
    priceUsdPerMegapixel: 0.012,
    source: 'https://fal.ai/models/fal-ai/flux-2',
  },
} as const;

export type CreativeProfile = (typeof CREATIVE_PROFILES)[keyof typeof CREATIVE_PROFILES];

export const IMAGE_SIZE_BY_RATIO = {
  '1:1': {width: 992, height: 992},
  '4:3': {width: 1024, height: 768},
  '3:4': {width: 768, height: 1024},
  '16:9': {width: 1024, height: 576},
  '9:16': {width: 576, height: 1024},
} as const;

export type CreativeAspectRatio = keyof typeof IMAGE_SIZE_BY_RATIO;

export const ASPECT_RATIO_VALUE: Record<CreativeAspectRatio, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

export const MAX_IMAGE_COST_USD = 0.25;
export const MAX_CREATIVE_PROMPT_LENGTH = 12_000;
