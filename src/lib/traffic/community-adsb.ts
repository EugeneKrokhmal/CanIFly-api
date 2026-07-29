/**
 * Community ADS-B feeds used when OpenSky is unreachable
 * (common from cloud hosts — OpenSky may block hyperscaler IPs).
 *
 * Parallel-fetch multiple free aggregators and keep the freshest
 * position per aircraft (lowest seen_pos).
 */

export type TrafficBbox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type CommunityAdsbSource = "adsb.lol" | "airplanes.live" | "adsb.fi";

type AdsbAircraft = {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | string;
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  lat?: number;
  lon?: number;
  seen?: number;
  seen_pos?: number;
};

type AdsbResponse = {
  ac?: AdsbAircraft[] | null;
};

const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;
const FT_MIN_TO_MS = 0.00508;

/** Drop reports older than this — stale ADS-B drifts badly when coasted. */
const MAX_SEEN_POS_S = 45;

function bboxCenterRadiusNm(bbox: TrafficBbox): {
  lat: number;
  lon: number;
  radiusNm: number;
} {
  const lat = (bbox.south + bbox.north) / 2;
  const lon = (bbox.west + bbox.east) / 2;
  const latKm = (bbox.north - bbox.south) * 111;
  const lonKm =
    (bbox.east - bbox.west) * 111 * Math.cos((lat * Math.PI) / 180);
  const radiusNm = Math.min(
    250,
    Math.max(25, (Math.hypot(latKm, lonKm) / 2 / 1.852) * 1.15),
  );
  return { lat, lon, radiusNm };
}

function inBbox(lat: number, lon: number, bbox: TrafficBbox): boolean {
  return (
    lat >= bbox.south &&
    lat <= bbox.north &&
    lon >= bbox.west &&
    lon <= bbox.east
  );
}

function altitudeM(raw: number | string | undefined): number | null {
  if (raw === "ground") return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw * FT_TO_M;
}

function seenPosSec(ac: AdsbAircraft): number {
  if (typeof ac.seen_pos === "number" && Number.isFinite(ac.seen_pos)) {
    return Math.max(0, ac.seen_pos);
  }
  if (typeof ac.seen === "number" && Number.isFinite(ac.seen)) {
    return Math.max(0, ac.seen);
  }
  // Unknown age — treat as moderately fresh so we don't drop everything.
  return 5;
}

function toFeature(
  ac: AdsbAircraft,
  bbox: TrafficBbox,
  source: CommunityAdsbSource,
): GeoJSON.Feature | null {
  const lat = ac.lat;
  const lon = ac.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inBbox(lat, lon, bbox)) return null;

  const ageS = seenPosSec(ac);
  if (ageS > MAX_SEEN_POS_S) return null;

  const alt =
    altitudeM(ac.alt_baro) ??
    (typeof ac.alt_geom === "number" ? ac.alt_geom * FT_TO_M : null);
  const onGround = ac.alt_baro === "ground" || alt === 0;
  if (onGround) return null;

  const icao24 = String(ac.hex ?? "")
    .toLowerCase()
    .replace(/^~/, "");
  if (!/^[0-9a-f]{6}$/.test(icao24)) return null;

  const callsign = (ac.flight ?? "").trim() || icao24.toUpperCase();
  const track =
    typeof ac.track === "number" && Number.isFinite(ac.track)
      ? ac.track
      : typeof ac.true_heading === "number" && Number.isFinite(ac.true_heading)
        ? ac.true_heading
        : 0;
  const velocityMs =
    typeof ac.gs === "number" && Number.isFinite(ac.gs)
      ? ac.gs * KT_TO_MS
      : null;
  const verticalRateMs =
    typeof ac.baro_rate === "number" && Number.isFinite(ac.baro_rate)
      ? ac.baro_rate * FT_MIN_TO_MS
      : typeof ac.geom_rate === "number" && Number.isFinite(ac.geom_rate)
        ? ac.geom_rate * FT_MIN_TO_MS
        : null;

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      icao24,
      callsign,
      originCountry: "",
      altitudeM: alt,
      onGround: false,
      velocityMs,
      trackDeg: track,
      verticalRateMs,
      squawk: ac.squawk ?? null,
      registration: ac.r ?? null,
      aircraftType: ac.t ?? null,
      seenPosSec: ageS,
      source,
    },
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<AdsbResponse> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CanIFly/1.0 (+https://canifly.org)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`adsb_http_${res.status}`);
  }
  return (await res.json()) as AdsbResponse;
}

function mergeFreshest(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  const byIcao = new Map<string, GeoJSON.Feature>();
  for (const f of features) {
    const icao = String(f.properties?.icao24 ?? "");
    if (!icao) continue;
    const age = Number(f.properties?.seenPosSec ?? 99);
    const prev = byIcao.get(icao);
    if (!prev) {
      byIcao.set(icao, f);
      continue;
    }
    const prevAge = Number(prev.properties?.seenPosSec ?? 99);
    if (age < prevAge) byIcao.set(icao, f);
  }
  return [...byIcao.values()];
}

/**
 * Live aircraft near bbox via public ADS-B aggregators (no API key).
 * Fetches feeds in parallel and keeps the freshest report per ICAO24.
 */
export async function fetchCommunityAdsb(
  bbox: TrafficBbox,
): Promise<{
  features: GeoJSON.Feature[];
  source: string;
  sources: CommunityAdsbSource[];
}> {
  const { lat, lon, radiusNm } = bboxCenterRadiusNm(bbox);
  const radius = Math.round(radiusNm);
  const urls: { source: CommunityAdsbSource; url: string }[] = [
    {
      source: "adsb.lol",
      url: `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radius}`,
    },
    {
      source: "airplanes.live",
      url: `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${radius}`,
    },
    {
      source: "adsb.fi",
      // v2 lat/lon/dist (opendata); some clusters also expose /v3/…
      url: `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radius}`,
    },
  ];

  const settled = await Promise.allSettled(
    urls.map(async (candidate) => {
      const payload = await fetchJson(candidate.url, 8_000);
      const features: GeoJSON.Feature[] = [];
      for (const ac of payload.ac ?? []) {
        const f = toFeature(ac, bbox, candidate.source);
        if (f) features.push(f);
      }
      return { source: candidate.source, features };
    }),
  );

  const ok: { source: CommunityAdsbSource; features: GeoJSON.Feature[] }[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      ok.push(result.value);
    } else {
      console.warn("[traffic] community feed failed", result.reason);
    }
  }

  if (ok.length === 0) {
    throw new Error("community_adsb_unavailable");
  }

  const merged = mergeFreshest(ok.flatMap((r) => r.features));
  const sources = ok.map((r) => r.source);
  return {
    features: merged,
    source: sources.length === 1 ? sources[0] : `merged:${sources.join("+")}`,
    sources,
  };
}
