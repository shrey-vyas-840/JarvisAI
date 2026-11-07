export interface OsmBusinessRecord {
  readonly name: string;
  readonly category: string;
  readonly address: string | null;
  readonly postcode: string | null;
  readonly locality: string | null;
  readonly city: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly openingHours: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly dataSource: string;
  readonly dataLicense: string;
  readonly attribution: string;
  readonly retrievalTimestamp: string;
}

export interface OsmSearchQuery {
  readonly area: string;
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
  readonly bbox?:
    | {
        readonly south: number;
        readonly west: number;
        readonly north: number;
        readonly east: number;
      }
    | undefined;
}

export interface OsmSearchResult {
  readonly queryArea: string;
  readonly category: string;
  readonly totalRetrieved: number;
  readonly returnedCount: number;
  readonly businesses: OsmBusinessRecord[];
  readonly dataSource: string;
  readonly dataLicense: string;
  readonly attribution: string;
  readonly limitations: string[];
}

export const OSM_DATA_SOURCE_NAME = 'OpenStreetMap';
export const OSM_LICENSE_NAME = 'Open Database License (ODbL) 1.0';
export const OSM_ATTRIBUTION =
  '© OpenStreetMap contributors (https://www.openstreetmap.org/copyright)';

export interface CategoryTagRule {
  readonly key: string;
  readonly value?: string;
}

export const CATEGORY_TAG_MAPPINGS: Record<string, CategoryTagRule[]> = {
  restaurants: [{ key: 'amenity', value: 'restaurant' }],
  cafes: [{ key: 'amenity', value: 'cafe' }],
  hotels: [{ key: 'tourism', value: 'hotel' }],
  shops: [{ key: 'shop' }],
  supermarkets: [{ key: 'shop', value: 'supermarket' }],
  hospitals: [{ key: 'amenity', value: 'hospital' }],
  clinics: [{ key: 'amenity', value: 'clinic' }],
  schools: [{ key: 'amenity', value: 'school' }],
  offices: [{ key: 'office' }],
  gyms: [{ key: 'leisure', value: 'fitness_centre' }],
  salons: [
    { key: 'shop', value: 'beauty' },
    { key: 'shop', value: 'hairdresser' },
  ],
  automotive: [
    { key: 'shop', value: 'car_repair' },
    { key: 'amenity', value: 'car_wash' },
  ],
  pharmacies: [{ key: 'amenity', value: 'pharmacy' }],
  banks: [{ key: 'amenity', value: 'bank' }],
};

export function resolveCategoryRules(categoryName: string): {
  canonical: string;
  rules: CategoryTagRule[];
} {
  const norm = categoryName.trim().toLowerCase();
  for (const [key, rules] of Object.entries(CATEGORY_TAG_MAPPINGS)) {
    if (norm === key || norm.startsWith(key) || key.startsWith(norm)) {
      return { canonical: key, rules };
    }
  }

  // Default to shops/amenity fallback
  return {
    canonical: norm,
    rules: [{ key: 'amenity', value: norm }],
  };
}
