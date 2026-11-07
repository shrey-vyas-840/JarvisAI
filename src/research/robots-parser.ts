export interface RobotsRule {
  readonly path: string;
  readonly allow: boolean;
}

export interface ParsedRobots {
  readonly rules: RobotsRule[];
  readonly crawlDelaySec?: number | undefined;
  readonly isAllowed: (urlPath: string) => boolean;
}

export function parseRobotsTxt(content: string, userAgent = '*'): ParsedRobots {
  const lines = content.split(/\r?\n/);
  const rules: RobotsRule[] = [];
  let crawlDelaySec: number | undefined;

  let currentApplies = false;
  let hasSpecificAgent = false;

  const targetAgent = userAgent.toLowerCase();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const [directive, ...rest] = line.split(':');
    if (!directive || rest.length === 0) continue;

    const key = directive.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      const agent = value.toLowerCase();
      if (agent === targetAgent || agent === 'jarvis' || agent === 'playwriter') {
        currentApplies = true;
        hasSpecificAgent = true;
      } else if (agent === '*' && !hasSpecificAgent) {
        currentApplies = true;
      } else {
        currentApplies = false;
      }
    } else if (currentApplies) {
      if (key === 'disallow') {
        if (!value) {
          // Empty disallow means allow all
          rules.push({ path: '/', allow: true });
        } else {
          rules.push({ path: value, allow: false });
        }
      } else if (key === 'allow') {
        if (value) {
          rules.push({ path: value, allow: true });
        }
      } else if (key === 'crawl-delay') {
        const delay = parseFloat(value);
        if (!isNaN(delay) && delay >= 0) {
          crawlDelaySec = delay;
        }
      }
    }
  }

  const isAllowed = (urlPath: string): boolean => {
    // If no rules, allowed by default
    if (rules.length === 0) return true;

    // In standard robots.txt evaluation, the longest matching rule wins
    let bestMatch: RobotsRule | null = null;
    let maxMatchLen = -1;

    for (const rule of rules) {
      if (pathMatchesRule(urlPath, rule.path)) {
        if (rule.path.length > maxMatchLen) {
          maxMatchLen = rule.path.length;
          bestMatch = rule;
        }
      }
    }

    if (!bestMatch) {
      return true;
    }

    return bestMatch.allow;
  };

  return {
    rules,
    crawlDelaySec,
    isAllowed,
  };
}

function pathMatchesRule(urlPath: string, rulePath: string): boolean {
  if (rulePath === '/') return true;

  // Handle prefix matching and wildcards where applicable
  if (rulePath.endsWith('*')) {
    const prefix = rulePath.slice(0, -1);
    return urlPath.startsWith(prefix);
  }

  if (rulePath.endsWith('$')) {
    const exact = rulePath.slice(0, -1);
    return urlPath === exact;
  }

  return urlPath.startsWith(rulePath);
}

export async function fetchRobotsTxt(origin: string, timeoutMs = 5000): Promise<ParsedRobots> {
  const robotsUrl = `${origin.replace(/\/+$/, '')}/robots.txt`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const res = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'JARVIS/0.1.0' },
    });
    clearTimeout(timer);

    if (res.status === 404) {
      // Missing robots.txt means everything is allowed
      return parseRobotsTxt('');
    }

    if (!res.ok) {
      // If 403 or server error on robots.txt, conservative approach disallows
      return {
        rules: [{ path: '/', allow: false }],
        isAllowed: () => false,
      };
    }

    const text = await res.text();
    return parseRobotsTxt(text);
  } catch {
    // If robots.txt cannot be reached, permit root navigation with empty rules
    return parseRobotsTxt('');
  }
}
