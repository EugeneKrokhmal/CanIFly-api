import { Hono } from "hono";
import { z } from "zod";
import { fetchCommunityAdsb } from "../lib/traffic/community-adsb";
import { openskyCredentialsConfigured } from "../lib/traffic/opensky-auth";
import {
  coalesceOpensky,
  fetchOpensky,
  getOpenskyCached,
  openskyBboxCacheKey,
  openskyCooldownActive,
  openskyCooldownRemainingMs,
  openskyUnreachableActive,
  setOpenskyCached,
} from "../lib/traffic/opensky-cache";

export const trafficRoutes = new Hono();

/** Long TTL — clients dead-reckon between refreshes. */
const STATES_TTL_MS = 90_000;
const TRACK_TTL_MS = 10 * 60_000;

const aircraftQuerySchema = z.object({
  west: z.coerce.number().min(-180).max(180),
  south: z.coerce.number().min(-90).max(90),
  east: z.coerce.number().min(-180).max(180),
  north: z.coerce.number().min(-90).max(90),
});

const trackQuerySchema = z.object({
  icao24: z
    .string()
    .min(6)
    .max(6)
    .regex(/^[0-9a-fA-F]{6}$/),
});

const IDX = {
  icao24: 0,
  callsign: 1,
  originCountry: 2,
  timePosition: 3,
  lastContact: 4,
  longitude: 5,
  latitude: 6,
  baroAltitude: 7,
  onGround: 8,
  velocity: 9,
  trueTrack: 10,
  verticalRate: 11,
  geoAltitude: 13,
  squawk: 14,
} as const;

type OpenSkyState = (string | number | boolean | null)[];

interface OpenSkyResponse {
  time?: number;
  states?: OpenSkyState[] | null;
}

type Waypoint = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  boolean,
];

interface OpenSkyTrack {
  icao24?: string;
  callsign?: string | null;
  startTime?: number;
  endTime?: number;
  path?: Waypoint[] | null;
}

type AircraftPayload = {
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
  meta: Record<string, unknown>;
};

type TrackPayload = {
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
  meta: Record<string, unknown>;
};

function emptyRateLimited(): AircraftPayload {
  return {
    type: "FeatureCollection",
    features: [],
    meta: {
      error: "rate_limited",
      source: "opensky",
      retryAfterMs: openskyCooldownRemainingMs(),
    },
  };
}

function featuresFromOpenSky(payload: OpenSkyResponse): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];

  for (const state of payload.states ?? []) {
    const lng = state[IDX.longitude];
    const lat = state[IDX.latitude];
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const onGround = Boolean(state[IDX.onGround]);
    // Skip parked / taxiing — less clutter, same OpenSky cost.
    if (onGround) continue;

    const callsignRaw = state[IDX.callsign];
    const callsign =
      typeof callsignRaw === "string" ? callsignRaw.trim() : "";
    const icao24 = String(state[IDX.icao24] ?? "");
    const baro =
      typeof state[IDX.baroAltitude] === "number"
        ? state[IDX.baroAltitude]
        : typeof state[IDX.geoAltitude] === "number"
          ? state[IDX.geoAltitude]
          : null;
    const velocity =
      typeof state[IDX.velocity] === "number" ? state[IDX.velocity] : null;
    const track =
      typeof state[IDX.trueTrack] === "number" ? state[IDX.trueTrack] : 0;
    const verticalRate =
      typeof state[IDX.verticalRate] === "number"
        ? state[IDX.verticalRate]
        : null;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        icao24,
        callsign: callsign || icao24.toUpperCase(),
        originCountry: state[IDX.originCountry] ?? "",
        altitudeM: baro,
        onGround,
        velocityMs: velocity,
        trackDeg: track,
        verticalRateMs: verticalRate,
        squawk: state[IDX.squawk] ?? null,
      },
    });
  }

  return features;
}

async function fetchOpenSkyAircraft(opts: {
  west: number;
  south: number;
  east: number;
  north: number;
}): Promise<AircraftPayload | null> {
  if (openskyCooldownActive() || openskyUnreachableActive()) return null;

  const url = new URL("https://opensky-network.org/api/states/all");
  url.searchParams.set("lamin", String(opts.south));
  url.searchParams.set("lomin", String(opts.west));
  url.searchParams.set("lamax", String(opts.north));
  url.searchParams.set("lomax", String(opts.east));

  try {
    const res = await fetchOpensky(url.toString());
    if (res.status === 429) return emptyRateLimited();
    if (!res.ok) return null;

    const payload = (await res.json()) as OpenSkyResponse;
    const features = featuresFromOpenSky(payload);
    return {
      type: "FeatureCollection",
      features,
      meta: {
        source: "opensky",
        authenticated: openskyCredentialsConfigured(),
        time: payload.time ?? null,
        count: features.length,
        west: opts.west,
        south: opts.south,
        east: opts.east,
        north: opts.north,
        cached: false,
      },
    };
  } catch (err) {
    console.warn("[traffic/aircraft] OpenSky unavailable, will fallback", err);
    return null;
  }
}

async function fetchCommunityAircraft(opts: {
  west: number;
  south: number;
  east: number;
  north: number;
}): Promise<AircraftPayload> {
  const { features, source } = await fetchCommunityAdsb(opts);
  return {
    type: "FeatureCollection",
    features,
    meta: {
      source,
      authenticated: false,
      time: Math.floor(Date.now() / 1000),
      count: features.length,
      west: opts.west,
      south: opts.south,
      east: opts.east,
      north: opts.north,
      cached: false,
    },
  };
}

trafficRoutes.get("/aircraft", async (c) => {
  try {
    const params = Object.fromEntries(
      new URL(c.req.url).searchParams.entries(),
    );
    const parsed = aircraftQuerySchema.safeParse(params);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid bbox", details: parsed.error.flatten() },
        400,
      );
    }

    let { west, south, east, north } = parsed.data;
    if (west >= east || south >= north) {
      return c.json({ error: "Invalid bbox order" }, 400);
    }

    const maxSpan = 6;
    if (east - west > maxSpan) {
      const mid = (west + east) / 2;
      west = mid - maxSpan / 2;
      east = mid + maxSpan / 2;
    }
    if (north - south > maxSpan) {
      const mid = (south + north) / 2;
      south = mid - maxSpan / 2;
      north = mid + maxSpan / 2;
    }

    const cacheKey = openskyBboxCacheKey(west, south, east, north);
    const cached = getOpenskyCached<AircraftPayload>(cacheKey);
    if (cached) {
      return c.json({
        ...cached,
        meta: { ...cached.meta, cached: true },
      });
    }

    const body = await coalesceOpensky(cacheKey, async () => {
      const again = getOpenskyCached<AircraftPayload>(cacheKey);
      if (again) return again;

      // Prefer OpenSky when reachable; community ADS-B when cloud IPs are blocked.
      const fromOpenSky = await fetchOpenSkyAircraft({
        west,
        south,
        east,
        north,
      });
      if (fromOpenSky) {
        if (fromOpenSky.meta?.error !== "rate_limited") {
          setOpenskyCached(cacheKey, fromOpenSky, STATES_TTL_MS);
        }
        return fromOpenSky;
      }

      const fromCommunity = await fetchCommunityAircraft({
        west,
        south,
        east,
        north,
      });
      setOpenskyCached(cacheKey, fromCommunity, STATES_TTL_MS);
      return fromCommunity;
    });

    if (body.meta?.error === "rate_limited") {
      // Still try community feed so the map is not empty during OpenSky cooldown.
      try {
        const fromCommunity = await fetchCommunityAircraft({
          west,
          south,
          east,
          north,
        });
        setOpenskyCached(cacheKey, fromCommunity, STATES_TTL_MS);
        return c.json(fromCommunity);
      } catch (err) {
        console.warn("[traffic/aircraft] community fallback failed", err);
        return c.json(body);
      }
    }
    return c.json(
      body.meta?.cached
        ? body
        : { ...body, meta: { ...body.meta, cached: false } },
    );
  } catch (err) {
    console.error("[traffic/aircraft]", err);
    return c.json({
      type: "FeatureCollection",
      features: [],
      meta: { error: "fetch_failed", source: "adsb" },
    });
  }
});

trafficRoutes.get("/track", async (c) => {
  try {
    const params = Object.fromEntries(
      new URL(c.req.url).searchParams.entries(),
    );
    const parsed = trackQuerySchema.safeParse(params);
    if (!parsed.success) {
      return c.json(
        {
          error: "icao24 must be a 6-char hex ICAO address",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    const icao24 = parsed.data.icao24.toLowerCase();
    const cacheKey = `track:${icao24}`;

    if (openskyCooldownActive()) {
      return c.json({
        type: "FeatureCollection",
        features: [],
        meta: {
          icao24,
          error: "rate_limited",
          source: "opensky",
          retryAfterMs: openskyCooldownRemainingMs(),
        },
      });
    }

    const cached = getOpenskyCached<TrackPayload>(cacheKey);
    if (cached) {
      return c.json({
        ...cached,
        meta: { ...cached.meta, cached: true },
      });
    }

    const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`;
    let res: Response;
    try {
      res = await fetchOpensky(url);
    } catch (err) {
      console.warn("[traffic/track] OpenSky unavailable", err);
      return c.json({
        type: "FeatureCollection",
        features: [],
        meta: { icao24, error: "unavailable", source: "opensky" },
      });
    }

    if (res.status === 404) {
      const body: TrackPayload = {
        type: "FeatureCollection",
        features: [],
        meta: { icao24, error: "no_track", source: "opensky" },
      };
      setOpenskyCached(cacheKey, body, TRACK_TTL_MS);
      return c.json(body);
    }

    if (res.status === 429) {
      return c.json({
        type: "FeatureCollection",
        features: [],
        meta: {
          icao24,
          error: "rate_limited",
          source: "opensky",
          retryAfterMs: openskyCooldownRemainingMs(),
        },
      });
    }

    if (!res.ok) {
      return c.json({
        type: "FeatureCollection",
        features: [],
        meta: { icao24, error: `opensky_${res.status}`, source: "opensky" },
      });
    }

    const payload = (await res.json()) as OpenSkyTrack;
    const coords: [number, number][] = [];
    const altitudes: (number | null)[] = [];

    for (const wp of payload.path ?? []) {
      const lat = wp[1];
      const lon = wp[2];
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      coords.push([lon, lat]);
      altitudes.push(typeof wp[3] === "number" ? wp[3] : null);
    }

    if (coords.length < 2) {
      const body: TrackPayload = {
        type: "FeatureCollection",
        features: [],
        meta: {
          icao24,
          callsign: payload.callsign?.trim() || null,
          error: "too_short",
          source: "opensky",
          waypointCount: coords.length,
        },
      };
      setOpenskyCached(cacheKey, body, TRACK_TTL_MS);
      return c.json(body);
    }

    const feature: GeoJSON.Feature = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        icao24: payload.icao24 ?? icao24,
        callsign: payload.callsign?.trim() || icao24.toUpperCase(),
        startTime: payload.startTime ?? null,
        endTime: payload.endTime ?? null,
        waypointCount: coords.length,
        altitudesM: altitudes,
      },
    };

    const body: TrackPayload = {
      type: "FeatureCollection",
      features: [feature],
      meta: {
        icao24,
        callsign: feature.properties?.callsign,
        waypointCount: coords.length,
        source: "opensky",
      },
    };
    setOpenskyCached(cacheKey, body, TRACK_TTL_MS);
    return c.json(body);
  } catch (err) {
    console.error("[traffic/track]", err);
    return c.json({
      type: "FeatureCollection",
      features: [],
      meta: { error: "fetch_failed", source: "opensky" },
    });
  }
});
