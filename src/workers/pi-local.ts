import {RouterError} from '../domain/errors.js';

/** Pi may call only a loopback OpenAI-compatible server configured by the operator. */
export function validatePiBaseUrl(value: string): string {
  let url: URL;
  try {url = new URL(value);} catch {throw new RouterError('invalid_config', 'Pi baseUrl must be an HTTP loopback URL');}
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new RouterError('invalid_config', 'Pi baseUrl must be an HTTP(S) loopback URL without credentials, query, or fragment');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new RouterError('invalid_config', 'Pi baseUrl must use localhost, 127.0.0.1, or [::1]');
  return url.toString().replace(/\/$/, '');
}

/** Isolated models.json. A real key stays in PI_LOCAL_API_KEY and is not written here. */
export function piLocalModelDocument(profile: {provider: string; model: string; baseUrl: string}): {providers: Record<string, unknown>} {
  return {providers: {[profile.provider]: {
    baseUrl: profile.baseUrl,
    api: 'openai-completions',
    apiKey: process.env.PI_LOCAL_API_KEY ? '$PI_LOCAL_API_KEY' : 'local',
    authHeader: true,
    models: [{id: profile.model, compat: {supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens'}}],
  }}};
}
