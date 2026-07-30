/**
 * Portuguese UAS geographical zones via ANAC open ED-269 JSON
 * (https://dnt.anac.pt/json/ — directory listing of versioned files).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
  parseEd269Payload,
} from "./ed269-national-cache";

const ANAC_JSON_DIR = "https://dnt.anac.pt/json/";

export class AnacFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnacFetchError";
  }
}

function pickLatestJsonHref(html: string): string | null {
  const hrefs = [...html.matchAll(/href="(\/json\/[^"]+\.json)"/gi)].map((m) => m[1]);
  if (hrefs.length === 0) return null;
  // Filenames embed timestamps; lexical last is usually newest.
  hrefs.sort();
  return hrefs[hrefs.length - 1] ?? null;
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  let listUrl = ANAC_JSON_DIR;
  try {
    const index = await fetch(ANAC_JSON_DIR, {
      headers: { Accept: "text/html,application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!index.ok) {
      throw new AnacFetchError(`HTTP ${index.status}`, ANAC_JSON_DIR, index.status);
    }
    const html = await index.text();
    const href = pickLatestJsonHref(html);
    if (!href) {
      throw new AnacFetchError("no JSON listed in ANAC /json/", ANAC_JSON_DIR);
    }
    listUrl = new URL(href, ANAC_JSON_DIR).toString();
    const response = await fetch(listUrl, {
      headers: { Accept: "application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new AnacFetchError(`HTTP ${response.status}`, listUrl, response.status);
    }
    const text = await response.text();
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    return parseEd269Payload(data, "PRT");
  } catch (err) {
    if (isTimeout(err)) {
      throw new AnacFetchError("anac timeout", listUrl, undefined, err);
    }
    throw err instanceof AnacFetchError
      ? err
      : new AnacFetchError(String(err), listUrl, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "anac",
  country: "PT",
  fetchZones: fetchNationalZones,
});

export const queryAnacPoint = client.queryPoint.bind(client);
export const queryAnacBbox = client.queryBbox.bind(client);
