/**
 * Estonian UAS geographical zones via EANS / Transpordiamet UTM AVM GeoJSON
 * (https://utm.eans.ee/avm/utm/uas.geojson).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
} from "./ed269-national-cache";
import { parseUtmAvmGeoJson } from "./utm-avm-geojson";

const EANS_UAS_GEOJSON = "https://utm.eans.ee/avm/utm/uas.geojson";

export class EansFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EansFetchError";
  }
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  try {
    const response = await fetch(EANS_UAS_GEOJSON, {
      headers: {
        Accept: "application/geo+json,application/json",
        "User-Agent": "CanIFly/0.3",
      },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new EansFetchError(
        `HTTP ${response.status}`,
        EANS_UAS_GEOJSON,
        response.status,
      );
    }
    const text = await response.text();
    if (/^\s*<!DOCTYPE html/i.test(text) || /Just a moment/i.test(text)) {
      throw new EansFetchError(
        "blocked by HTML challenge page",
        EANS_UAS_GEOJSON,
      );
    }
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    return parseUtmAvmGeoJson(data, "EST");
  } catch (err) {
    if (isTimeout(err)) {
      throw new EansFetchError("eans timeout", EANS_UAS_GEOJSON, undefined, err);
    }
    throw err instanceof EansFetchError
      ? err
      : new EansFetchError(String(err), EANS_UAS_GEOJSON, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "eans",
  country: "EE",
  fetchZones: fetchNationalZones,
});

export const queryEansPoint = client.queryPoint.bind(client);
export const queryEansBbox = client.queryBbox.bind(client);
