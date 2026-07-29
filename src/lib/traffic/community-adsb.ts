/**
 * Community ADS-B feeds used when OpenSky is unreachable
 * (common from cloud hosts — OpenSky may block hyperscaler IPs).
 */

export type TrafficBbox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

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
  // Cover the bbox circle + a little margin; APIs use nautical miles (max ~250).
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

function toFeature(
  ac: AdsbAircraft,
  bbox: TrafficBbox,
): GeoJSON.Feature | null {
  const lat = ac.lat;
  const lon = ac.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inBbox(lat, lon, bbox)) return null;

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

/**
 * Live aircraft near bbox via public ADS-B aggregators (no API key).
 * Tries adsb.lol → airplanes.live → adsb.fi.
 */
export async function fetchCommunityAdsb(
  bbox: TrafficBbox,
): Promise<{
  features: GeoJSON.Feature[];
  source: "adsb.lol" | "airplanes.live" | "adsb.fi";
}> {
  const { lat, lon, radiusNm } = bboxCenterRadiusNm(bbox);
  const radius = Math.round(radiusNm);
  const urls: {
    source: "adsb.lol" | "airplanes.live" | "adsb.fi";
    url: string;
  }[] = [
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
      url: `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radius}`,
    },
  ];

  let lastErr: unknown;
  for (const candidate of urls) {
    try {
      const payload = await fetchJson(candidate.url, 12_000);
      const features: GeoJSON.Feature[] = [];
      for (const ac of payload.ac ?? []) {
        const f = toFeature(ac, bbox);
        if (f) features.push(f);
      }
      return { features, source: candidate.source };
    } catch (err) {
      lastErr = err;
      console.warn(`[traffic] ${candidate.source} failed`, err);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("community_adsb_unavailable");
}
