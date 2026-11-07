import { describe, it, expect } from 'vitest';

import { OverpassAdapter } from '../../src/geo/overpass-adapter.js';
import { resolveCategoryRules } from '../../src/geo/osm-types.js';

describe('OverpassAdapter & Category Rules', () => {
  it('maps categories to explicit, tested OSM tags', () => {
    const rest = resolveCategoryRules('restaurants');
    expect(rest.canonical).toBe('restaurants');
    expect(rest.rules[0]?.key).toBe('amenity');
    expect(rest.rules[0]?.value).toBe('restaurant');

    const hosp = resolveCategoryRules('hospitals');
    expect(hosp.canonical).toBe('hospitals');
    expect(hosp.rules[0]?.key).toBe('amenity');
    expect(hosp.rules[0]?.value).toBe('hospital');

    const shops = resolveCategoryRules('shops');
    expect(shops.canonical).toBe('shops');
    expect(shops.rules[0]?.key).toBe('shop');
  });

  it('builds controlled Overpass query templates with area scoping', () => {
    const adapter = new OverpassAdapter();

    const q1 = adapter.buildOverpassQuery({
      area: 'Ahmedabad',
      category: 'restaurants',
      limit: 20,
    });
    expect(q1.queryText).toContain('area["name"="Ahmedabad"]->.searchArea;');
    expect(q1.queryText).toContain('node["amenity"="restaurant"](area.searchArea);');
    expect(q1.queryText).toContain('out center 20;');

    const q2 = adapter.buildOverpassQuery({ area: '380009', category: 'cafes', limit: 15 });
    expect(q2.queryText).toContain('postal_code');
    expect(q2.queryText).toContain('out center 15;');
  });

  it('correctly maps raw OSM elements to OsmBusinessRecord with provenance', async () => {
    const mockElements = [
      {
        type: 'node',
        id: 101,
        lat: 23.0225,
        lon: 72.5714,
        tags: {
          name: 'The Green Cafe',
          amenity: 'cafe',
          'addr:street': 'CG Road',
          'addr:housenumber': '42',
          'addr:city': 'Ahmedabad',
          phone: '+91 79 12345678',
          website: 'https://greencafe.example',
          opening_hours: 'Mo-Su 08:00-22:00',
        },
      },
      {
        type: 'way',
        id: 202,
        center: { lat: 23.03, lon: 72.58 },
        tags: {
          name: 'Minimal Cafe',
          amenity: 'cafe',
        },
      },
    ];

    const adapter = new OverpassAdapter({
      mockFetcher: () => Promise.resolve({ elements: mockElements }),
    });

    const result = await adapter.search({ area: 'Ahmedabad', category: 'cafes', limit: 10 });

    expect(result.returnedCount).toBe(2);
    expect(result.dataSource).toBe('OpenStreetMap');
    expect(result.dataLicense).toContain('ODbL');
    expect(result.attribution).toContain('OpenStreetMap contributors');

    const first = result.businesses[0];
    expect(first).toBeDefined();
    expect(first?.name).toBe('The Green Cafe');
    expect(first?.address).toBe('42 CG Road');
    expect(first?.phone).toBe('+91 79 12345678');
    expect(first?.website).toBe('https://greencafe.example');
    expect(first?.latitude).toBe(23.0225);
    expect(first?.sourceUrl).toBe('https://www.openstreetmap.org/node/101');

    const second = result.businesses[1];
    expect(second).toBeDefined();
    expect(second?.name).toBe('Minimal Cafe');
    // Missing fields remain null/empty
    expect(second?.address).toBeNull();
    expect(second?.phone).toBeNull();
    expect(second?.website).toBeNull();
    expect(second?.openingHours).toBeNull();
    expect(second?.latitude).toBe(23.03);
    expect(second?.sourceUrl).toBe('https://www.openstreetmap.org/way/202');
  });

  it('caches identical queries to prevent repetitive requests', async () => {
    let fetchCount = 0;
    const adapter = new OverpassAdapter({
      mockFetcher: () => {
        fetchCount++;
        return Promise.resolve({ elements: [] });
      },
    });

    await adapter.search({ area: 'Ahmedabad', category: 'cafes', limit: 5 });
    await adapter.search({ area: 'Ahmedabad', category: 'cafes', limit: 5 });

    expect(fetchCount).toBe(1);
  });
});
