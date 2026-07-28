# CanIFly API

Hono + PostGIS backend for CanIFly (airspace status, zones, obstacles, auth, traffic, weather, drones).

## Requirements

- Node.js 20+
- Docker (for PostGIS)

## Setup

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run dev
```

API listens on **http://localhost:4000**.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with `tsx watch` on port 4000 |
| `npm start` | Start without watch |
| `npm run db:up` | Start PostGIS (`canifly-postgis`) |
| `npm run db:migrate` | Ensure PostGIS schema / tables |
| `npm run typecheck` | `tsc --noEmit` |

## Key routes

- `GET /api/airspace/status`
- `GET /api/zones/bbox`
- `GET /api/obstacles/bbox`, `POST /api/obstacles`, `DELETE /api/obstacles/:id`, `POST /api/obstacles/:id/vote`
- `POST /api/auth/register`, `/login`, `/logout`, `GET /api/auth/me`
- `PATCH|DELETE /api/account`
- `GET /api/traffic/aircraft`, `/api/traffic/track`
- `GET /api/weather`
- `GET /api/drones/catalog`
- `GET /api/pilots/:id`
- `GET|POST /api/admin/ingest` (requires `ENAIRE_INGEST_SECRET`)
- `GET /uploads/*` — static obstacle/avatar photos

Shared schemas and geo helpers come from `@canifly/middleware` (`../CanIFly-middleware`).
