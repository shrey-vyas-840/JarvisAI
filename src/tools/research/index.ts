import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import { crawlWebsite } from '../../research/crawler.js';

export function createResearchTools(): ToolDefinition[] {
  const researchSchema = z.object({
    startUrl: z.string().min(1).describe('The HTTP or HTTPS starting URL to research.'),
    researchGoal: z.string().min(3).describe('The research topic, question, or goal.'),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Maximum pages to crawl (1-25, default: 5).'),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(2)
      .optional()
      .describe('Maximum link crawl depth (1-2, default: 1).'),
  });

  const tool: ToolDefinition = {
    name: 'research_website',
    description:
      'Crawl and research public pages starting from a given website URL. Respects robots.txt, applies conservative rate limits, prevents cycles, deduplicates URLs, extracts content, and returns structured findings with full source URLs and timestamps.',
    permission: 'read-only',
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {
        startUrl: {
          type: 'string',
          description: 'Starting HTTP or HTTPS URL to research.',
        },
        researchGoal: {
          type: 'string',
          description: 'The research goal or query to investigate.',
        },
        maxPages: {
          type: 'integer',
          description: 'Maximum pages to inspect (default: 5, max: 25).',
        },
        maxDepth: {
          type: 'integer',
          description: 'Maximum link traversal depth (default: 1, max: 2).',
        },
      },
      required: ['startUrl', 'researchGoal'],
    },
    argumentsSchema: researchSchema,
    execute: async (rawArgs: unknown) => {
      const args = researchSchema.parse(rawArgs);
      const crawlResult = await crawlWebsite(args.startUrl, {
        maxPages: args.maxPages,
        maxDepth: args.maxDepth,
      });

      // Filter and synthesize findings
      const findings = crawlResult.pages
        .filter((p) => p.status === 'success')
        .map((p) => ({
          url: p.url,
          title: p.title,
          contentSummary: p.textSnippet.slice(0, 1500),
          length: p.fullTextLength,
          truncated: p.truncated,
          retrievedAt: p.timestamp,
        }));

      return {
        researchGoal: args.researchGoal,
        startUrl: crawlResult.startUrl,
        domain: crawlResult.domain,
        totalPagesCrawled: crawlResult.totalPagesCrawled,
        robotsPolicy: crawlResult.robotsPolicy,
        findings,
        skippedUrls: crawlResult.skippedUrls,
        limitations: crawlResult.limitations,
      };
    },
  };

  return [tool];
}
