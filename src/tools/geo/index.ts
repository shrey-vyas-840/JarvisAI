import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import { OverpassAdapter } from '../../geo/overpass-adapter.js';

export interface GeoToolsOptions {
  readonly adapter?: OverpassAdapter;
}

export function createGeoTools(options: GeoToolsOptions = {}): ToolDefinition[] {
  const adapter = options.adapter ?? new OverpassAdapter();

  const searchSchema = z.object({
    area: z
      .string()
      .min(2)
      .describe(
        'Geographic area name, city, locality, or postal code (e.g. "Ahmedabad", "Navrangpura", "380009").',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Business category, e.g. "restaurants", "cafes", "hotels", "shops", "supermarkets", "hospitals", "clinics", "schools", "gyms", "salons", "automotive", "pharmacies", "banks". Defaults to "restaurants".',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of business records to return (default: 25, max: 100).'),
  });

  const tool: ToolDefinition = {
    name: 'search_businesses_open_data',
    description:
      'Search businesses, amenities, and public facilities using verified OpenStreetMap open data under the ODbL license. Returns structured records including names, categories, addresses, contact details, coordinates, and full attribution. This tool adheres strictly to Google Maps policies by using open public data rather than scraping restricted Google Maps content.',
    permission: 'read-only',
    timeoutMs: 35000,
    parameters: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          description: 'Geographic area name, locality, city, or postal code.',
        },
        category: {
          type: 'string',
          description: 'Business category to search for.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to retrieve (default: 25, max: 100).',
        },
      },
      required: ['area'],
    },
    argumentsSchema: searchSchema,
    execute: async (rawArgs: unknown) => {
      const args = searchSchema.parse(rawArgs);
      return adapter.search({
        area: args.area,
        category: args.category,
        limit: args.limit,
      });
    },
  };

  return [tool];
}
