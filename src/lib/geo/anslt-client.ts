/**
 * Lithuanian UAS geographical zones via Oro navigacija UTM AVM GeoJSON
 * (https://utm.ans.lt/avm/utm/uas.geojson).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
} from "./ed269-national-cache";
import { parseUtmAvmGeoJson } from "./utm-avm-geojson";

const ANSLT_UAS_GEOJSON = "https://utm.ans.lt/avm/utm/uas.geojson";

export class AnsltFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnsltFetchError";
  }
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  try {
    // Cloudflare on utm.ans.lt rejects sparse bot UAs; mirror a normal browser.
    const response = await fetch(ANSLT_UAS_GEOJSON, {
      headers: {
        Accept: "application/geo+json,application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new AnsltFetchError(
        `HTTP ${response.status}`,
        ANSLT_UAS_GEOJSON,
        response.status,
      );
    }
    const text = await response.text();
    if (/^\s*<!DOCTYPE html/i.test(text) || /Just a moment/i.test(text)) {
      throw new AnsltFetchError(
        "blocked by HTML challenge page (Cloudflare)",
        ANSLT_UAS_GEOJSON,
      );
    }
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    return parseUtmAvmGeoJson(data, "LTU");
  } catch (err) {
    if (isTimeout(err)) {
      throw new AnsltFetchError(
        "anslt timeout",
        ANSLT_UAS_GEOJSON,
        undefined,
        err,
      );
    }
    throw err instanceof AnsltFetchError
      ? err
      : new AnsltFetchError(String(err), ANSLT_UAS_GEOJSON, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "anslt",
  country: "LT",
  fetchZones: fetchNationalZones,
});

export const queryAnsltPoint = client.queryPoint.bind(client);
export const queryAnsltBbox = client.queryBbox.bind(client);
