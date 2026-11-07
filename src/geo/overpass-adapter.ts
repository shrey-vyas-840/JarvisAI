import {
  OSM_ATTRIBUTION,
  OSM_DATA_SOURCE_NAME,
  OSM_LICENSE_NAME,
  resolveCategoryRules,
  type OsmBusinessRecord,
  type OsmSearchQuery,
  type OsmSearchResult,
} from './osm-types.js';

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

export interface OverpassAdapterOptions {
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly mockFetcher?: ((query: string) => Promise<unknown>) | undefined;
}

interface RawOsmElement {
  readonly type: 'node' | 'way' | 'relation';
  readonly id: number;
  readonly lat?: number | undefined;
  readonly lon?: number | undefined;
  readonly center?: { readonly lat: number; readonly lon: number } | undefined;
  readonly tags?: Record<string, string> | undefined;
}

export class OverpassAdapter {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly mockFetcher?: ((query: string) => Promise<unknown>) | undefined;
  private readonly cache = new Map<string, OsmSearchResult>();

  public constructor(options: OverpassAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_OVERPASS_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.mockFetcher = options.mockFetcher;
  }

  public buildOverpassQuery(query: OsmSearchQuery): {
    queryText: string;
    canonicalCategory: string;
  } {
    const rawCategory = query.category ?? 'restaurants';
    const { canonical, rules } = resolveCategoryRules(rawCategory);
    const limit = Math.min(query.limit ?? 25, 100);
    const cleanArea = query.area.replace(/["\\]/g, '').trim();

    const isPostalCode = /^[0-9A-Za-z -]{3,10}$/.test(cleanArea) && /\d/.test(cleanArea);

    let areaSelector: string;
    if (isPostalCode) {
      areaSelector = `(area["postal_code"="${cleanArea}"]; area["addr:postcode"="${cleanArea}"];)->.searchArea;`;
    } else {
      areaSelector = `area["name"="${cleanArea}"]->.searchArea;`;
    }

    const filters: string[] = [];
    for (const rule of rules) {
      const tagFilter = rule.value ? `["${rule.key}"="${rule.value}"]` : `["${rule.key}"]`;
      filters.push(`node${tagFilter}(area.searchArea);`);
      filters.push(`way${tagFilter}(area.searchArea);`);
      filters.push(`relation${tagFilter}(area.searchArea);`);
    }

    const queryText = `[out:json][timeout:25];
${areaSelector}
(
  ${filters.join('\n  ')}
);
out center ${String(limit)};`;

    return { queryText, canonicalCategory: canonical };
  }

  public async search(query: OsmSearchQuery): Promise<OsmSearchResult> {
    const cacheKey = `${query.area.toLowerCase()}:${(query.category ?? 'restaurants').toLowerCase()}:${String(query.limit ?? 25)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const { queryText, canonicalCategory } = this.buildOverpassQuery(query);
    const limit = Math.min(query.limit ?? 25, 100);

    let rawData: { elements?: RawOsmElement[] };
    if (this.mockFetcher) {
      rawData = (await this.mockFetcher(queryText)) as { elements?: RawOsmElement[] };
    } else {
      rawData = await this.executeHttpQuery(queryText);
    }

    const elements = rawData.elements ?? [];
    const businesses: OsmBusinessRecord[] = [];
    const timestamp = new Date().toISOString();

    for (const el of elements) {
      const tags = el.tags ?? {};
      const name = tags.name ?? tags['name:en'] ?? null;
      if (!name) {
        // Skip unnamed points
        continue;
      }

      const lat = el.lat ?? el.center?.lat ?? 0;
      const lon = el.lon ?? el.center?.lon ?? 0;

      let address: string | null = null;
      if (tags['addr:full']) {
        address = tags['addr:full'];
      } else if (tags['addr:street']) {
        const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean);
        address = parts.join(' ');
      }

      const phone = tags.phone ?? tags['contact:phone'] ?? null;
      const website = tags.website ?? tags['contact:website'] ?? null;
      const openingHours = tags.opening_hours ?? null;
      const postcode = tags['addr:postcode'] ?? null;
      const city = tags['addr:city'] ?? query.area;
      const locality = tags['addr:suburb'] ?? tags['addr:district'] ?? null;

      const sourceId = `${el.type}/${String(el.id)}`;
      const sourceUrl = `https://www.openstreetmap.org/${el.type}/${String(el.id)}`;

      businesses.push({
        name,
        category: canonicalCategory,
        address,
        postcode,
        locality,
        city,
        phone,
        website,
        openingHours,
        latitude: lat,
        longitude: lon,
        sourceId,
        sourceUrl,
        dataSource: OSM_DATA_SOURCE_NAME,
        dataLicense: OSM_LICENSE_NAME,
        attribution: OSM_ATTRIBUTION,
        retrievalTimestamp: timestamp,
      });

      if (businesses.length >= limit) {
        break;
      }
    }

    const limitations: string[] = [
      'OpenStreetMap data is community-contributed; coverage in specific localities or postal codes depends on contributor mapping.',
      'Only verified tags from OpenStreetMap are returned; missing phone, address, or website fields remain null.',
      'No ratings or review counts are manufactured or copied from Google Maps.',
      `Attribution notice: ${OSM_ATTRIBUTION}`,
    ];

    const result: OsmSearchResult = {
      queryArea: query.area,
      category: canonicalCategory,
      totalRetrieved: elements.length,
      returnedCount: businesses.length,
      businesses,
      dataSource: OSM_DATA_SOURCE_NAME,
      dataLicense: OSM_LICENSE_NAME,
      attribution: OSM_ATTRIBUTION,
      limitations,
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  private async executeHttpQuery(queryText: string): Promise<{ elements: RawOsmElement[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'JARVIS-OpenData-Agent/0.1.0 (+https://github.com/shrey-vyas-840/JarvisAI)',
        },
        body: `data=${encodeURIComponent(queryText)}`,
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new Error(
          'Overpass API rate limit reached (HTTP 429). Please wait before making further queries.',
        );
      }

      if (!res.ok) {
        throw new Error(`Overpass API returned HTTP ${String(res.status)}: ${res.statusText}`);
      }

      const json = (await res.json()) as { elements?: RawOsmElement[] };
      return { elements: json.elements ?? [] };
    } finally {
      clearTimeout(timer);
    }
  }
}
