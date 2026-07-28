import {
  ED318_SOURCES,
  SERVAIS_FEATURE_SERVER_BASE,
  SERVAIS_MAX_PAGE_SIZE,
  SERVAIS_LAYER_IDS,
} from "@canifly/middleware";
import type {
  MatchedZone,
  UasRestriction,
  UasZoneFeature,
  UasZonesFile,
  ZoneSource,
} from "@canifly/middleware";
import { toMeters } from "@canifly/middleware";

export class EnaireFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EnaireFetchError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json, application/geo+json, */*",
          ...(init?.headers ?? {}),
        },
      });
      if (response.ok) return response;
      if (response.status >= 500 || response.status === 429) {
        lastError = new EnaireFetchError(
          `HTTP ${response.status}`,
          url,
          response.status,
        );
        if (attempt < retries) {
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
      }
      throw new EnaireFetchError(
        `Request failed with status ${response.status}`,
        url,
        response.status,
      );
    } catch (err) {
      lastError = err;
      if (
        err instanceof EnaireFetchError &&
        err.statusCode &&
        err.statusCode < 500 &&
        err.statusCode !== 429
      ) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
    }
  }

  throw new EnaireFetchError(
    `Failed after ${retries + 1} attempts`,
    url,
    undefined,
    lastError,
  );
}

function isUasZoneFeature(value: unknown): value is UasZoneFeature {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.identifier === "string" &&
    typeof v.name === "string" &&
    Array.isArray(v.geometry)
  );
}

export function normalizeEd318Payload(payload: unknown): UasZoneFeature[] {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload.filter(isUasZoneFeature);
  }

  if (typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.features)) {
    const features = obj.features as unknown[];
    if (
      features.length > 0 &&
      features[0] &&
      typeof features[0] === "object" &&
      "type" in (features[0] as object) &&
      (features[0] as { type?: string }).type === "Feature"
    ) {
      return features.flatMap((f) => {
        const feature = f as GeoJSON.Feature;
        const props = feature.properties;
        if (isUasZoneFeature(props)) {
          if (
            (!props.geometry || props.geometry.length === 0) &&
            feature.geometry
          ) {
            return [
              {
                ...props,
                geometry: [
                  {
                    upperLimit: Number(
                      (props as { upperLimit?: number }).upperLimit ?? 120,
                    ),
                    lowerLimit: Number(
                      (props as { lowerLimit?: number }).lowerLimit ?? 0,
                    ),
                    uomDimensions: "M",
                    upperVerticalReference: "AGL",
                    lowerVerticalReference: "AGL",
                    horizontalProjection: feature.geometry as
                      | GeoJSON.Polygon
                      | GeoJSON.MultiPolygon,
                  },
                ],
              },
            ];
          }
          return [props];
        }
        if (props && typeof props === "object") {
          const mapped = servaisAttributesToMatchedZone(
            props as Record<string, unknown>,
            "aero",
          );
          const geom =
            feature.geometry &&
            (feature.geometry.type === "Polygon" ||
              feature.geometry.type === "MultiPolygon")
              ? (feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon)
              : null;
          if (!mapped || !geom) return [];
          return [
            {
              identifier: mapped.identifier,
              country: "ESP",
              name: mapped.name,
              type: mapped.source,
              restriction: mapped.restriction,
              reason: mapped.reason,
              message: mapped.message,
              zoneAuthority: mapped.contact
                ? [{ email: mapped.contact, purpose: "AUTHORIZATION" }]
                : undefined,
              geometry: [
                {
                  upperLimit: mapped.upperLimitM,
                  lowerLimit: mapped.lowerLimitM,
                  uomDimensions: "M",
                  upperVerticalReference: mapped.upperRef,
                  lowerVerticalReference: mapped.lowerRef,
                  horizontalProjection: geom,
                },
              ],
            } satisfies UasZoneFeature,
          ];
        }
        return [];
      });
    }

    return (features as unknown[]).filter(isUasZoneFeature);
  }

  if (isUasZoneFeature(obj)) return [obj];
  return [];
}

/** Normalize ENAIRE servAIS attribute bags into MatchedZone. */
export function servaisAttributesToMatchedZone(
  attrs: Record<string, unknown>,
  source: ZoneSource,
): MatchedZone | null {
  const identifier = String(
    attrs.identifier ?? attrs.Identifier ?? attrs.OBJECTID ?? "",
  );
  if (!identifier) return null;

  // ENAIRE stores the ED-318 restriction in `type`, and zone kind in `variant`.
  const restrictionRaw = String(
    attrs.restriction ??
      attrs.Restriction ??
      attrs.type ??
      attrs.Type ??
      "REQ_AUTHORISATION",
  );
  const restriction = (restrictionRaw === "REQ_AUTHORIZATION"
    ? "REQ_AUTHORISATION"
    : restrictionRaw) as UasRestriction;

  const reasonsRaw = attrs.reasons ?? attrs.reason ?? attrs.Reason;
  const reason = Array.isArray(reasonsRaw)
    ? reasonsRaw.map(String)
    : reasonsRaw
      ? String(reasonsRaw)
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const uom = String(attrs.uom ?? attrs.uomDimensions ?? "M");
  const lower = Number(attrs.lower ?? attrs.lowerLimit ?? 0);
  const upper = Number(attrs.upper ?? attrs.upperLimit ?? 120);

  return {
    identifier,
    name: String(attrs.name ?? attrs.Name ?? identifier),
    restriction,
    reason,
    source,
    lowerLimitM: toMeters(lower, uom),
    upperLimitM: toMeters(upper, uom),
    lowerRef: String(attrs.lowerReference ?? attrs.lowerVerticalReference ?? "AGL"),
    upperRef: String(attrs.upperReference ?? attrs.upperVerticalReference ?? "AGL"),
    contact: attrs.email ? String(attrs.email) : undefined,
    message: attrs.message ? String(attrs.message) : undefined,
  };
}

function arcgisRingsToPolygon(
  rings: number[][][],
): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  if (rings.length === 1) {
    return { type: "Polygon", coordinates: rings };
  }
  // Heuristic: treat each ring group as separate polygon outer ring
  return {
    type: "MultiPolygon",
    coordinates: rings.map((ring) => [ring]),
  };
}

interface ArcGisFeature {
  attributes?: Record<string, unknown>;
  geometry?: { rings?: number[][][]; x?: number; y?: number };
  properties?: Record<string, unknown>;
  type?: string;
}

interface ArcGisQueryResponse {
  features?: ArcGisFeature[];
  exceededTransferLimit?: boolean;
  error?: { message?: string; code?: number };
}

function layerSource(layerId: number): ZoneSource {
  if (layerId === SERVAIS_LAYER_IDS.urbano) return "urbano";
  if (layerId === SERVAIS_LAYER_IDS.infra) return "infra";
  return "aero";
}

/**
 * Live point query against all UAS layers (primary path for status).
 */
export async function queryServaisPoint(
  lat: number,
  lng: number,
): Promise<MatchedZone[]> {
  const layers = [
    SERVAIS_LAYER_IDS.aero,
    SERVAIS_LAYER_IDS.urbano,
    SERVAIS_LAYER_IDS.infra,
  ];
  const matches: MatchedZone[] = [];
  const seen = new Set<string>();

  await Promise.all(
    layers.map(async (layerId) => {
      const params = new URLSearchParams({
        geometry: `${lng},${lat}`,
        geometryType: "esriGeometryPoint",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*",
        returnGeometry: "false",
        f: "json",
        resultRecordCount: "50",
      });
      const url = `${SERVAIS_FEATURE_SERVER_BASE}/${layerId}/query?${params}`;
      try {
        const response = await fetchWithRetry(url, undefined, {
          retries: 2,
          baseDelayMs: 300,
        });
        const payload = (await response.json()) as ArcGisQueryResponse;
        if (payload.error) {
          throw new EnaireFetchError(
            payload.error.message ?? "servAIS error",
            url,
            payload.error.code,
          );
        }
        for (const feature of payload.features ?? []) {
          const attrs = feature.attributes ?? feature.properties ?? {};
          const zone = servaisAttributesToMatchedZone(
            attrs,
            layerSource(layerId),
          );
          if (!zone) continue;
          const key = `${zone.identifier}:${zone.lowerLimitM}:${zone.upperLimitM}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push(zone);
        }
      } catch (err) {
        console.warn(`[servAIS] layer ${layerId} point query failed`, err);
      }
    }),
  );

  return matches;
}

/**
 * Live bbox query for map rendering (GeoJSON FeatureCollection).
 */
export async function queryServaisBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 500,
): Promise<GeoJSON.FeatureCollection> {
  const layers = [
    SERVAIS_LAYER_IDS.aero,
    SERVAIS_LAYER_IDS.urbano,
    SERVAIS_LAYER_IDS.infra,
  ];
  const features: GeoJSON.Feature[] = [];
  const perLayer = Math.max(50, Math.floor(limit / layers.length));

  await Promise.all(
    layers.map(async (layerId) => {
      const params = new URLSearchParams({
        geometry: JSON.stringify({
          xmin: west,
          ymin: south,
          xmax: east,
          ymax: north,
          spatialReference: { wkid: 4326 },
        }),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*",
        returnGeometry: "true",
        f: "json",
        resultRecordCount: String(perLayer),
      });
      const url = `${SERVAIS_FEATURE_SERVER_BASE}/${layerId}/query?${params}`;
      try {
        const response = await fetchWithRetry(url, undefined, {
          retries: 1,
          baseDelayMs: 300,
        });
        const payload = (await response.json()) as ArcGisQueryResponse;
        if (payload.error) return;

        for (const feature of payload.features ?? []) {
          const attrs = feature.attributes ?? {};
          const zone = servaisAttributesToMatchedZone(
            attrs,
            layerSource(layerId),
          );
          const rings = feature.geometry?.rings;
          if (!zone || !rings?.length) continue;
          features.push({
            type: "Feature",
            geometry: arcgisRingsToPolygon(rings),
            properties: {
              identifier: zone.identifier,
              name: zone.name,
              restriction: zone.restriction,
              reason: zone.reason,
              source: zone.source,
              lowerLimitM: zone.lowerLimitM,
              upperLimitM: zone.upperLimitM,
              lowerRef: zone.lowerRef,
              upperRef: zone.upperRef,
              message: zone.message,
            },
          });
        }
      } catch (err) {
        console.warn(`[servAIS] layer ${layerId} bbox query failed`, err);
      }
    }),
  );

  return { type: "FeatureCollection", features };
}

export async function downloadEd318Source(
  source: keyof typeof ED318_SOURCES,
): Promise<{ features: UasZoneFeature[]; source: ZoneSource; bytes: number }> {
  const meta = ED318_SOURCES[source];
  const response = await fetchWithRetry(meta.url);
  const buffer = Buffer.from(await response.arrayBuffer());

  let text: string;
  if (meta.url.endsWith(".zip") || buffer[0] === 0x50 /* P of PK */) {
    const { unzipSync } = await import("node:zlib");
    // Prefer JSZip-less approach: use adm-zip? Not installed.
    // Use dynamic unzip via child process? Better install nothing — use fflate or manual.
    // For zip we use the `unzip` via shell is bad. Use built-in: download JSON from FeatureServer instead.
    // Parse zip with simple inflate of first entry is hard. Use `jszip` or just throw to FeatureServer.
    text = await unzipFirstJson(buffer);
  } else {
    text = buffer.toString("utf8");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (err) {
    throw new EnaireFetchError(
      "Invalid JSON from ED-318 source",
      meta.url,
      undefined,
      err,
    );
  }
  const features = normalizeEd318Payload(payload);
  return { features, source: meta.id, bytes: buffer.length };
}

async function unzipFirstJson(buffer: Buffer): Promise<string> {
  // Minimal ZIP local-file extract for single-entry ENAIRE archives.
  const { inflateRawSync } = await import("node:zlib");
  if (buffer.toString("ascii", 0, 2) !== "PK") {
    throw new EnaireFetchError("Not a ZIP archive", "zip");
  }
  // Local file header
  const compression = buffer.readUInt16LE(8);
  const compSize = buffer.readUInt32LE(18);
  const nameLen = buffer.readUInt16LE(26);
  const extraLen = buffer.readUInt16LE(28);
  const name = buffer.toString("utf8", 30, 30 + nameLen);
  const dataStart = 30 + nameLen + extraLen;
  const compressed = buffer.subarray(dataStart, dataStart + compSize);
  let data: Buffer;
  if (compression === 0) {
    data = compressed;
  } else if (compression === 8) {
    data = inflateRawSync(compressed);
  } else {
    throw new EnaireFetchError(`Unsupported ZIP compression ${compression}`, name);
  }
  return data.toString("utf8");
}

export async function downloadEd318File(
  filePath: string,
): Promise<UasZoneFeature[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(filePath, "utf8");
  const payload = JSON.parse(text) as UasZonesFile | unknown;
  return normalizeEd318Payload(payload);
}

export async function fetchServaisLayer(
  layerId: number,
): Promise<GeoJSON.Feature[]> {
  const all: GeoJSON.Feature[] = [];
  let offset = 0;

  for (;;) {
    const params = new URLSearchParams({
      where: "1=1",
      outFields: "*",
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: String(SERVAIS_MAX_PAGE_SIZE),
    });
    const url = `${SERVAIS_FEATURE_SERVER_BASE}/${layerId}/query?${params.toString()}`;
    const response = await fetchWithRetry(url);
    const payload = (await response.json()) as {
      features?: GeoJSON.Feature[];
      exceededTransferLimit?: boolean;
      error?: { message?: string; code?: number };
    };

    if (payload.error) {
      throw new EnaireFetchError(
        payload.error.message ?? "servAIS error",
        url,
        payload.error.code,
      );
    }

    const batch = payload.features ?? [];
    all.push(...batch);

    if (batch.length < SERVAIS_MAX_PAGE_SIZE && !payload.exceededTransferLimit) {
      break;
    }
    offset += batch.length;
    if (batch.length === 0) break;
  }

  return all;
}

export async function listServaisLayers(): Promise<
  { id: number; name: string }[]
> {
  try {
    const url = `${SERVAIS_FEATURE_SERVER_BASE}?f=json`;
    const response = await fetchWithRetry(url);
    const payload = (await response.json()) as {
      layers?: { id: number; name: string }[];
    };
    return (
      payload.layers ?? [
        { id: SERVAIS_LAYER_IDS.aero, name: "ZGUAS_Aero" },
        { id: SERVAIS_LAYER_IDS.urbano, name: "ZGUAS_Urbano" },
        { id: SERVAIS_LAYER_IDS.infra, name: "ZGUAS_Infraestructuras" },
      ]
    );
  } catch {
    return [
      { id: SERVAIS_LAYER_IDS.infra, name: "ZGUAS_Infraestructuras" },
      { id: SERVAIS_LAYER_IDS.aero, name: "ZGUAS_Aero" },
      { id: SERVAIS_LAYER_IDS.urbano, name: "ZGUAS_Urbano" },
    ];
  }
}
