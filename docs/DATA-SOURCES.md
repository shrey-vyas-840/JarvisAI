# JARVIS Data Sources and Usage Policies

This document records the provenance, licensing, limitations, and operational boundaries for external data sources utilized by JARVIS Phase 4.

---

## 1. Google Maps Interaction Boundary

JARVIS strictly separates **interactive user-directed browser navigation** from **bulk automated data extraction**.

### Allowed Interactive Usage

- Navigating to `https://www.google.com/maps`.
- Searching locations, addresses, and geographic coordinates requested by the user.
- Switching between satellite, terrain, and map views.
- Requesting routing and directions interactively.
- Visual inspection via browser accessibility tree, DOM locators, and screenshots.

### Strict Prohibitions

- In accordance with Google Maps Web Service Policies and Terms of Service, JARVIS **does not scrape, copy, or export Google Maps data** into external databases or spreadsheets.
- In particular, business names, addresses, ratings, user reviews, photos, or place details are **never** harvested from Google Maps to manufacture standalone export products.

---

## 2. OpenStreetMap (OSM) Open Data Adapter

For bulk business research, directory lookups, and verified Excel workbook generation, JARVIS uses open public data from **OpenStreetMap**.

- **Primary Project**: [OpenStreetMap Foundation](https://www.openstreetmap.org/)
- **Data Engine**: Overpass API interpreter
- **License**: [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/)
- **Attribution Requirement**: _"© OpenStreetMap contributors"_ ([openstreetmap.org/copyright](https://www.openstreetmap.org/copyright))

### Query Strategy

- LLMs are **never** permitted to generate arbitrary Overpass QL strings directly.
- Controlled, tested query templates map natural-language categories (e.g. `restaurants`, `hospitals`, `supermarkets`) to explicit OSM tag key-value pairs (e.g. `amenity=restaurant`, `amenity=hospital`, `shop=supermarket`).
- Geographic scoping uses resolved boundary areas (`area["name"=...]` or `area["postal_code"=...]`).
- Result sizes are bounded (default 25, maximum 100).
- Rate limits and HTTP 429 status codes are strictly respected with timeouts and in-memory query caching.

### Data Fields & Integrity

- Only verified tags present in OpenStreetMap are returned.
- Missing phone, address, website, or opening hours fields remain explicitly `null`/blank.
- **No ratings or review counts are fabricated** or backfilled from Google Maps.
- Every business record retains full provenance:
  - `sourceId`: OSM element type and numeric ID (e.g. `node/1234567`)
  - `sourceUrl`: Permanent link (`https://www.openstreetmap.org/node/1234567`)
  - `dataSource`: `OpenStreetMap`
  - `dataLicense`: `Open Database License (ODbL) 1.0`
  - `attribution`: `© OpenStreetMap contributors`
  - `retrievalTimestamp`: ISO 8601 UTC timestamp

---

## 3. Web Crawling & Public Research Data

For open web crawling (`research_website`):

- All target domains are evaluated against `robots.txt` before fetching.
- Rate limits: minimum 2000 ms delay between successive requests to the same origin.
- Same-origin domain enforcement is active by default.
- Bounded recursion: maximum 25 pages, maximum depth 2.
- Webpage content is treated strictly as **untrusted data**, never executable instructions or policy overrides.
