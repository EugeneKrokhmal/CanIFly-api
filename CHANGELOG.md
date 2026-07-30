# Changelog

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
