# Changelog

## Unreleased

### Added
- Latvia live provider via LGS/drz.lv ED-269 JSON (`lgs-client.ts`, backend label `lgs`)
- Ireland live provider via IAA UAS GeoJSON (`iaa-client.ts`, backend label `iaa`)
- Sweden live provider via LFV Drönarkarta WFS (`lfv-client.ts`, backend label `lfv`)
- Portugal live provider via ANAC ED-269 JSON (`anac-client.ts`, backend label `anac`)
- Austria live provider via Austro Control ED-269 ZIP (`austro-client.ts`, backend label `austro`)
- Shared ED-269 national cache helper (`ed269-national-cache.ts`)
- Switzerland live provider via FOCA SwissUASGeozones (`foca-client.ts`, backend label `foca`)
- Denmark live provider via Trafikstyrelsen Dronezoner GeoJSON (`dronezoner-client.ts`, backend label `dronezoner`)
- France live provider via Géoportail WFS (`geopf-client.ts`, backend label `geopf`)
- German mail locale (`de`) for verification and password-reset emails
- French mail locale (`fr`) for verification and password-reset emails
- Germany live provider via dipul WFS (`dipul-client.ts`, backend label `dipul`)
- LuftVO-oriented open-category restriction mapping (airports / ED-R / military → PROHIBITED)

### Changed
- Memory guard: treat high RSS (not only V8 heap) as pressure; free geo caches before DIPUL
- DIPUL: cap WFS layer concurrency to 4 (was unbounded Promise.all) to avoid Render exit 134 when loading Germany
- Czechia aimgis: AD_perimeter / LKR314 inner zones and military ODOS map to PROHIBITED; `mapStatus` from `zoneVisualStatus`

## [0.3.0] — 2026-07-30

### Added
- Czechia live provider via ANS CR **aimgis.rlp.cz** ArcGIS (`anscr-client.ts`, backend label `aimgis`)
- Shared PostGIS point/bbox helpers for Spain fallback

## [0.2.2] — 2026-07-30

### Added
- `/health` reports `pansaConfigured` (key present, not the secret)
- Poland provider failures surface as `meta.providerError` instead of a silent fake clear

## [0.2.1] — 2026-07-30

### Added
- `GET /api/pilots/top` — leaders by map pins left (empty list when DB is down)

### Fixed
- Local Docker PostGIS: skip TLS for localhost so the API can reach the DB

## [0.2.0] — 2026-07-30

### Added
- Country airspace provider registry (`SpainProvider`, `PolandProvider`)
- Live PANSA DroneMap client (`PANSA_API_KEY`) with TLS intermediate pin for the PANSA host
- Status / bbox routing by country; multi-country bbox merge when the map spans ES + PL
- Coverage via middleware `inCoverageHint` (Spain + Poland)

### Ops
- Set `PANSA_API_KEY` on Render before Poland queries work in production

## [0.1.0]

Spain ENAIRE + PostGIS API, auth, traffic, obstacles.
