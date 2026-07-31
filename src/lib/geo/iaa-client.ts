/**
 * Irish UAS geographical zones via IAA open GeoJSON
 * (https://www.iaa.ie/general-aviation/drones/uas-geographic-zones).
 *
 * Dated download URLs rotate — we scrape the official page for the latest
 * `*_uas_zones_ireland_v1.geojson` then cache + query like other ED-269 nationals.
 * IAA stores restriction in `properties.type` (US spelling AUTHORIZATION) and
 * geometry as GeoJSON MultiPolygon (not an ED-269 volume array).
 */
import type {
  UasRestriction,
  UasZoneFeature,
  UasZoneGeometry,
} from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
} from "./ed269-national-cache";

const IAA_ZONES_PAGE =
  "https://www.iaa.ie/general-aviation/drones/uas-geographic-zones";

export class IaaFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IaaFetchError";
  }
}

function pickLatestGeoJsonHref(html: string): string | null {
  const hrefs = [
    ...html.matchAll(
      /href="(\/docs\/default-source\/default-document-library\/uas\/[^"]+\.geojson[^"]*)"/gi,
    ),
  ].map((m) => m[1].replace(/&amp;/g, "&"));
  if (hrefs.length === 0) return null;
  // Filenames embed YYYYMMDD — lexical last is usually newest.
  hrefs.sort();
  return hrefs[hrefs.length - 1] ?? null;
}

function normalizeRestriction(raw: unknown): UasRestriction {
  const s = String(raw ?? "REQ_AUTHORISATION")
    .trim()
    .toUpperCase()
    .replace(/REQ_AUTHORIZATION/g, "REQ_AUTHORISATION");
  if (s === "PROHIBITED") return "PROHIBITED";
  if (s === "CONDITIONAL") return "CONDITIONAL";
  if (s === "NO_RESTRICTION") return "NO_RESTRICTION";
  if (s === "USPACE") return "USPACE";
  return "REQ_AUTHORISATION";
}

function geoJsonFeatureToZone(raw: unknown): UasZoneFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as GeoJSON.Feature;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const identifier = String(props.identifier ?? "").trim();
  if (!identifier) return null;
  const geom = f.geometry;
  if (
    !geom ||
    (geom.type !== "Polygon" && geom.type !== "MultiPolygon")
  ) {
    return null;
  }
  const reasonRaw = props.reason;
  const reason = Array.isArray(reasonRaw)
    ? reasonRaw.map(String)
    : reasonRaw
      ? [String(reasonRaw)]
      : [];
  const limited = props.limitedApplicability;
  const applicability = Array.isArray(limited)
    ? (limited as UasZoneFeature["applicability"])
    : undefined;
  const volume: UasZoneGeometry = {
    lowerLimit: 0,
    upperLimit: 120,
    uomDimensions: "M",
    lowerVerticalReference: "AGL",
    upperVerticalReference: "AGL",
    horizontalProjection: geom,
  };
  return {
    identifier,
    country: String(props.country ?? "IRL"),
    name: String(props.name ?? identifier),
    type: String(props.variant ?? props.type ?? "COMMON"),
    restriction: normalizeRestriction(props.type),
    reason,
    otherReasonInfo: props.otherReasonInfo
      ? String(props.otherReasonInfo)
      : undefined,
    message: props.message ? String(props.message) : undefined,
    applicability,
    zoneAuthority: Array.isArray(props.zoneAuthority)
      ? (props.zoneAuthority as UasZoneFeature["zoneAuthority"])
      : undefined,
    geometry: [volume],
    ...(props.restrictionConditions
      ? { restrictionConditions: props.restrictionConditions }
      : {}),
  } as UasZoneFeature;
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  let fileUrl = IAA_ZONES_PAGE;
  try {
    const index = await fetch(IAA_ZONES_PAGE, {
      headers: {
        Accept: "text/html,application/json",
        "User-Agent": "CanIFly/0.3",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!index.ok) {
      throw new IaaFetchError(`HTTP ${index.status}`, IAA_ZONES_PAGE, index.status);
    }
    const html = await index.text();
    const href = pickLatestGeoJsonHref(html);
    if (!href) {
      throw new IaaFetchError("no GeoJSON link on IAA UAS zones page", IAA_ZONES_PAGE);
    }
    fileUrl = new URL(href, IAA_ZONES_PAGE).toString();
    const response = await fetch(fileUrl, {
      headers: { Accept: "application/json,application/geo+json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new IaaFetchError(`HTTP ${response.status}`, fileUrl, response.status);
    }
    const text = await response.text();
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as GeoJSON.FeatureCollection;
    if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      return [];
    }
    return data.features
      .map(geoJsonFeatureToZone)
      .filter((z): z is UasZoneFeature => z != null);
  } catch (err) {
    if (isTimeout(err)) {
      throw new IaaFetchError("iaa timeout", fileUrl, undefined, err);
    }
    throw err instanceof IaaFetchError
      ? err
      : new IaaFetchError(String(err), fileUrl, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "iaa",
  country: "IE",
  fetchZones: fetchNationalZones,
});

export const queryIaaPoint = client.queryPoint.bind(client);
export const queryIaaBbox = client.queryBbox.bind(client);
