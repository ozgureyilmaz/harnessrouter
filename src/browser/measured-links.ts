const MAX_LINKS = 8;

export interface MeasuredLink {
  text: string;
  href: string;
}

/** Keep public HTTPS anchors measured from the page. Off-allowlist targets stay, because the observation is the href, not permission to navigate. */
export function sanitizeMeasuredLinks(value: unknown): MeasuredLink[] {
  if (!Array.isArray(value)) return [];
  const links: MeasuredLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as {text?: unknown; href?: unknown};
    if (typeof record.text !== 'string' || typeof record.href !== 'string') continue;
    const text = record.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 200) continue;
    let url: URL;
    try {
      url = new URL(record.href);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
    url.hash = '';
    links.push({text, href: url.href});
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}
