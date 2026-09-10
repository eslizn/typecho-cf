/**
 * Verify that an inbound trackback/pingback source page really links to the
 * target content before the feedback can be published.
 *
 * The pingback specification expects the consumer to fetch the source URI and
 * confirm it references the target; the previous implementation skipped that
 * step, so any unauthenticated POST could publish a comment row for an
 * arbitrary URL. The result now decides between `approved` and `waiting`
 * (see incoming-feedback.ts) — an unverifiable source is kept for review
 * instead of being dropped, so nothing is lost.
 */
import { fetchWithTimeout } from '@/lib/fetch';

const VERIFY_TIMEOUT_MS = 5_000;
/** Only this much of the source document is scanned for the backlink. */
const MAX_SOURCE_BYTES = 256 * 1024;

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
]);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];

/**
 * Cheap SSRF guard: only public http(s) hosts are fetched. Cloudflare Workers
 * cannot reach the loopback/private network the way a Node server can, but the
 * plugin-facing helper is also used from tests and local dev, so the check is
 * kept explicit rather than assumed.
 */
export function isFetchableFeedbackSource(sourceUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host)) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (host.startsWith('[')) return false; // IPv6 literal

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 0
      || a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
    ) {
      return false;
    }
  }

  return true;
}

/** True when the source document links back to `targetUrl`. */
export async function verifyFeedbackSource(sourceUrl: string, targetUrl: string): Promise<boolean> {
  if (!isFetchableFeedbackSource(sourceUrl) || !targetUrl) return false;

  try {
    const response = await fetchWithTimeout(sourceUrl, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Typecho-CF feedback verifier',
      },
    }, VERIFY_TIMEOUT_MS);
    if (!response.ok) return false;

    const body = await readCappedText(response, MAX_SOURCE_BYTES);
    return bodyContainsTarget(body, sourceUrl, targetUrl);
  } catch {
    // Network failure, timeout, or a body that could not be read: treat the
    // source as unverified so the feedback lands in the moderation queue.
    return false;
  }
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed.
    }
  }
  return text;
}

function bodyContainsTarget(body: string, sourceUrl: string, targetUrl: string): boolean {
  if (!body) return false;
  return urlCandidates(targetUrl, sourceUrl).some((candidate) => body.includes(candidate));
}

/**
 * Spellings a backlink can take in the source document: absolute, absolute
 * without the trailing slash, HTML-escaped ampersands, and the site-relative
 * path (which is how most themes actually render the link).
 */
export function urlCandidates(targetUrl: string, sourceUrl?: string): string[] {
  const candidates = new Set<string>();
  const trimmed = targetUrl.replace(/\/+$/, '');

  for (const value of new Set([targetUrl, trimmed])) {
    if (!value) continue;
    candidates.add(value);
    candidates.add(value.replace(/&/g, '&amp;'));
  }

  const origin = sourceUrl ? safeOrigin(sourceUrl) : null;
  if (origin) {
    try {
      const parsed = new URL(targetUrl);
      const path = parsed.pathname;
      candidates.add(path);
      candidates.add(path.replace(/\/+$/, ''));
      candidates.add(`${parsed.pathname}${parsed.search}`);
    } catch {
      // targetUrl was not absolute; nothing else to add.
    }
  }

  return [...candidates].filter(Boolean);
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
