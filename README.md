# CanIFly API

Hono HTTP API for **CanIFly** — airspace evaluation, UAS zone queries, community obstacles, JWT auth, aircraft traffic, weather, and drone catalog.

Runs on **port 4000** by default. The Next.js app ([CanIFly](https://github.com/EugeneKrokhmal/CanIFly)) proxies `/api` and `/uploads` here.

Shared domain logic lives in [`@canifly/middleware`](https://github.com/EugeneKrokhmal/CanIFly-middleware) (`file:../CanIFly-middleware`).

---

## Role in the system

```
Browser → CanIFly (:3000) ──rewrite──► CanIFly-api (:4000)
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
               PostGIS                 ENAIRE/servAIS            OpenSky
           (zones, users,           (UAS zone geometry)      (live traffic)
            obstacles, votes)
```

This service owns:

- Persistence (PostGIS + Drizzle)
- Session cookies / JWT
- Uploaded obstacle & avatar photos under `uploads/`
- Upstream integrations and caching
- Calling middleware helpers to **classify** status and **filter** zones

It does **not** render the map or own UI copy (except Accept-Language–aware domain labels via middleware).

---

## Technical decisions

| Decision | Rationale |
|----------|-----------|
| **Hono + `@hono/node-server`** | Small, typed routing; easy CORS; works as a plain Node process (no Next API routes) |
| **PostGIS** | Zone polygons need spatial queries (`ST_Intersects`, bbox); obstacle points similarly |
| **Drizzle ORM** | Typed schema close to SQL; migrations/bootstrap via `ensurePostgisSchema` |
| **JWT in httpOnly cookie** | Browser same-origin via Next rewrite; `jose` for sign/verify |
| **`@canifly/middleware`** | Zod request schemas + `classifyStatus` / `filterByProfile` stay identical for web/tests |
| **Docker Compose PostGIS** | Reproducible local DB (`canifly` / `canifly-postgis`); separate from any legacy DB |
| **servAIS FeatureServer + ED-318 ZIPs** | Live/bbox pulls and batch ingest paths for ENAIRE UAS geometry |
| **OpenSky via API** | Keeps API keys/rate limits and cache off the browser |
| **Memory/demo bootstrap** | Can load fixture zones when DB empty so status works before full ingest |

### Auth model

- `POST /api/auth/register` / `login` → sets session cookie
- `GET /api/auth/me` → current user
- `POST /api/auth/logout` → clears session
- Account profile: `PATCH|DELETE /api/account` (bio, avatar, operator number, delete)

### Obstacles & votes

- Types: `construction`, `crane`, `electric_line`, `air_sports`, `other`
- Votes stored in `obstacle_votes`; **inactive** when `dislikes / total > 0.5` (`isObstacleInactive` in middleware)
- Authors cannot vote on their own reports

### Airspace status pipeline

1. Validate query with `pointStatusQuerySchema` (middleware)
2. Resolve overlapping zones for the point (PostGIS / fixtures)
3. Build `DroneProfile` (Open category + `openCategoryCeiling`)
4. Filter + `classifyStatus` → Clear / Limited / Restricted / Prohibited + matched zones / free-band ceiling

Classification encodes ENAIRE quirks (hard no-fly aerodrome IDs, national population advisories, free VLOS bands encoded in `lower` limits, etc.) — see middleware docs.

---

## Requirements

- Node.js **20+**
- Docker (Colima / Desktop) for PostGIS
- Sibling `CanIFly-middleware` built at least once (`npm run build`)

---

## Setup

```bash
cd ../CanIFly-middleware && npm install && npm run build && cd -

cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run dev
```

Health check: `GET http://localhost:4000/health` → `{"ok":true,"service":"canifly-api"}`.

### Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection (`postgresql://canifly:canifly@localhost:5432/canifly`) |
| `JWT_SECRET` | Signing secret for sessions |
| `ENAIRE_INGEST_SECRET` | Protects admin ingest endpoints |
| `PORT` | Listen port (default `4000`) |
| `CORS_ORIGIN` | Allowed browser origin (e.g. `http://localhost:3000`) |
| `APP_URL` | Public web origin for email links (e.g. `https://canifly.es`) |
| `RESEND_API_KEY` | Resend API key for verification emails (required in production) |
| `MAIL_FROM` | From address, e.g. `CanIFly <noreply@yourdomain.com>` |
| `OPENSKY_CLIENT_ID` | OpenSky API client id (OAuth2 client credentials) |
| `OPENSKY_CLIENT_SECRET` | OpenSky API client secret |

Never commit `.env`.

### Docker

`docker-compose.yml` starts `postgis/postgis:16-3.4` as **`canifly-postgis`**, DB/user/password **`canifly`**, port **5432**, with init SQL under `docker/`.

```bash
npm run db:up      # docker compose up -d
npm run db:down
npm run db:migrate # ensure PostGIS extension + tables
```

---

## Project structure

```
CanIFly-api/
├── docker/                 # PostGIS init
├── docker-compose.yml
├── uploads/                # runtime photos (gitignored content)
├── scripts/
├── src/
│   ├── index.ts            # Hono app, CORS, /health, route mount, static uploads
│   ├── routes/
│   │   ├── airspace.ts     # GET /status
│   │   ├── zones.ts        # bbox GeoJSON
│   │   ├── obstacles.ts    # CRUD + votes
│   │   ├── auth.ts
│   │   ├── account.ts
│   │   ├── traffic.ts
│   │   ├── weather.ts
│   │   ├── drones.ts
│   │   ├── pilots.ts
│   │   └── admin.ts        # ingest (secret)
│   └── lib/
│       ├── db/             # client, schema, queries, bootstrap, memory-store
│       ├── auth/           # jwt, password, session
│       ├── geo/            # enaire-client, fixtures
│       ├── traffic/        # opensky-cache
│       ├── obstacles/      # photo handling, labels
│       ├── drones/
│       └── weather/
└── package.json
```

---

## HTTP API (summary)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | Liveness |
| `GET` | `/api/airspace/status` | `lat`, `lng`, `altitudeAgl`, `weightClass` |
| `GET` | `/api/zones/bbox` | Map layer GeoJSON |
| `GET` | `/api/obstacles/bbox` | Obstacle GeoJSON |
| `POST` | `/api/obstacles` | Create (auth) |
| `DELETE` | `/api/obstacles/:id` | Delete (auth / owner) |
| `POST` | `/api/obstacles/:id/vote` | up / down |
| `POST` | `/api/auth/register` \| `/login` \| `/logout` | |
| `GET` | `/api/auth/me` | |
| `PATCH` \| `DELETE` | `/api/account` | Profile / wipe account |
| `GET` | `/api/traffic/aircraft` \| `/track` | OpenSky |
| `GET` | `/api/weather` | Point weather |
| `GET` | `/api/drones/catalog` | Known drone models / classes |
| `GET` | `/api/pilots/:id` | Public pilot profile |
| `GET` \| `POST` | `/api/admin/ingest` | Requires `ENAIRE_INGEST_SECRET` |
| `GET` | `/uploads/*` | Static files |

Prefer sending `Accept-Language: es` or `en` for domain labels where implemented.

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | `tsx watch` on `:4000` |
| `npm start` | `tsx` without watch |
| `npm run db:up` / `db:down` | Compose PostGIS |
| `npm run db:migrate` | Ensure schema |
| `npm run typecheck` | `tsc --noEmit` |

---

## Related

- Web UI: [CanIFly](https://github.com/EugeneKrokhmal/CanIFly)
- Shared geo/schemas: [CanIFly-middleware](https://github.com/EugeneKrokhmal/CanIFly-middleware)
