import { validateBrowserUrl } from '../browser/url-guard.js';
import { fetchRobotsTxt, parseRobotsTxt, type ParsedRobots } from './robots-parser.js';

export interface CrawlPageResult {
  readonly url: string;
  readonly depth: number;
  readonly title: string;
  readonly textSnippet: string;
  readonly fullTextLength: number;
  readonly truncated: boolean;
  readonly discoveredLinksCount: number;
  readonly timestamp: string;
  readonly status: 'success' | 'failed' | 'skipped';
  readonly error?: string | undefined;
}

export interface CrawledWebsiteResult {
  readonly startUrl: string;
  readonly domain: string;
  readonly totalPagesCrawled: number;
  readonly pages: CrawlPageResult[];
  readonly skippedUrls: { url: string; reason: string }[];
  readonly robotsPolicy: string;
  readonly limitations: string[];
}

export interface CrawlOptions {
  readonly maxPages?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly allowExternalDomains?: boolean | undefined;
  readonly mockRobotsTxt?: string | undefined;
  readonly mockFetcher?:
    | ((
        url: string,
      ) => Promise<{ title: string; text: string; links: string[]; status?: number | undefined }>)
    | undefined;
}

export const MAX_CRAWL_PAGES_LIMIT = 25;
export const MAX_CRAWL_DEPTH_LIMIT = 2;
export const DEFAULT_PAGE_TEXT_LIMIT = 30000;

export async function crawlWebsite(
  startUrl: string,
  options: CrawlOptions = {},
): Promise<CrawledWebsiteResult> {
  const urlCheck = validateBrowserUrl(startUrl);
  if (!urlCheck.valid || !urlCheck.sanitizedUrl) {
    throw new Error(`Invalid start URL: ${urlCheck.error ?? 'unknown error'}`);
  }

  const startParsed = new URL(urlCheck.sanitizedUrl);
  const domain = startParsed.hostname;
  const origin = startParsed.origin;

  const maxPages = Math.min(options.maxPages ?? 5, MAX_CRAWL_PAGES_LIMIT);
  const maxDepth = Math.min(options.maxDepth ?? 1, MAX_CRAWL_DEPTH_LIMIT);
  const delayMs = options.delayMs ?? 2000;
  const allowExternal = options.allowExternalDomains ?? false;

  let robots: ParsedRobots;
  if (options.mockRobotsTxt !== undefined) {
    robots = parseRobotsTxt(options.mockRobotsTxt);
  } else {
    robots = await fetchRobotsTxt(origin);
  }

  const queue: { url: string; depth: number }[] = [{ url: startParsed.href, depth: 0 }];
  const visitedUrls = new Set<string>();
  const queuedUrls = new Set<string>([normalizeUrl(startParsed.href)]);
  const crawledPages: CrawlPageResult[] = [];
  const skippedUrls: { url: string; reason: string }[] = [];
  const limitations: string[] = [
    `Crawl bounded to maximum ${String(maxPages)} pages and depth ${String(maxDepth)}.`,
    'Webpage content is treated strictly as untrusted data.',
    'Robots.txt rules and rate limits strictly respected.',
  ];

  while (queue.length > 0 && crawledPages.length < maxPages) {
    const item = queue.shift();
    if (!item) break;

    const currentUrl = item.url;
    const currentDepth = item.depth;
    const normalized = normalizeUrl(currentUrl);

    if (visitedUrls.has(normalized)) {
      continue;
    }
    visitedUrls.add(normalized);

    let parsedItem: URL;
    try {
      parsedItem = new URL(currentUrl);
    } catch {
      skippedUrls.push({ url: currentUrl, reason: 'invalid_url' });
      continue;
    }

    // Origin check
    if (!allowExternal && parsedItem.hostname.toLowerCase() !== domain.toLowerCase()) {
      skippedUrls.push({ url: currentUrl, reason: 'external_domain_prohibited' });
      continue;
    }

    // robots.txt check
    if (!robots.isAllowed(parsedItem.pathname)) {
      skippedUrls.push({ url: currentUrl, reason: 'robots_disallowed' });
      continue;
    }

    // Enforce polite delay between page fetches
    if (crawledPages.length > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    try {
      let pageData: { title: string; text: string; links: string[]; status?: number | undefined };
      if (options.mockFetcher) {
        pageData = await options.mockFetcher(currentUrl);
      } else {
        pageData = await fetchPageContent(currentUrl);
      }

      const textLength = pageData.text.length;
      const truncated = textLength > DEFAULT_PAGE_TEXT_LIMIT;
      const cleanText = truncated ? pageData.text.slice(0, DEFAULT_PAGE_TEXT_LIMIT) : pageData.text;

      crawledPages.push({
        url: currentUrl,
        depth: currentDepth,
        title: pageData.title,
        textSnippet: cleanText,
        fullTextLength: textLength,
        truncated,
        discoveredLinksCount: pageData.links.length,
        timestamp: new Date().toISOString(),
        status: 'success',
      });

      // If within depth limit, enqueue discovered links
      if (currentDepth < maxDepth) {
        for (const link of pageData.links) {
          try {
            const resolved = new URL(link, currentUrl).href;
            const normLink = normalizeUrl(resolved);
            if (!visitedUrls.has(normLink) && !queuedUrls.has(normLink)) {
              queuedUrls.add(normLink);
              queue.push({ url: resolved, depth: currentDepth + 1 });
            }
          } catch {
            // Ignore unparseable link
          }
        }
      }
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'Unknown fetch error';
      crawledPages.push({
        url: currentUrl,
        depth: currentDepth,
        title: '',
        textSnippet: '',
        fullTextLength: 0,
        truncated: false,
        discoveredLinksCount: 0,
        timestamp: new Date().toISOString(),
        status: 'failed',
        error: message,
      });
    }
  }

  return {
    startUrl,
    domain,
    totalPagesCrawled: crawledPages.length,
    pages: crawledPages,
    skippedUrls,
    robotsPolicy:
      robots.rules.length > 0
        ? `${String(robots.rules.length)} rule(s) evaluated`
        : 'default-allow',
    limitations,
  };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let p = u.pathname;
    if (p.endsWith('/') && p.length > 1) {
      p = p.slice(0, -1);
    }
    u.pathname = p;
    return u.href;
  } catch {
    return url;
  }
}

async function fetchPageContent(
  url: string,
): Promise<{ title: string; text: string; links: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 25000);

  const res = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'JARVIS-Research-Agent/0.1.0 (+https://github.com/shrey-vyas-840/JarvisAI)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  clearTimeout(timer);

  if (res.status === 403) {
    throw new Error('Access forbidden (HTTP 403). Automated extraction stopped.');
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`Rate limited (HTTP 429). Retry-After: ${retryAfter ?? 'unknown'}.`);
  }

  if (!res.ok) {
    throw new Error(`HTTP error ${String(res.status)}: ${res.statusText}`);
  }

  const html = await res.text();

  // Extract title
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? titleMatch[1].trim() : '';

  // Extract links
  const links: string[] = [];
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null = linkRegex.exec(html);
  while (match !== null) {
    const rawHref = match[1];
    if (rawHref && !rawHref.startsWith('#') && !rawHref.startsWith('javascript:')) {
      links.push(rawHref);
    }
    match = linkRegex.exec(html);
  }

  // Strip script, style, html tags for text
  const cleanHtml = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title,
    text: cleanHtml,
    links,
  };
}
