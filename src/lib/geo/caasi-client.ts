/**
 * Slovenian UAS geographical zones via CAA Slovenia KMZ ZIP
 * (https://www.caa.si/en/geographical-restrictions-for-uas.html).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
  unzipFirstKml,
} from "./ed269-national-cache";
import { parseKmlUasZones, sloveniaRestriction } from "./kml-zones";

const CAASI_ZONES_PAGE =
  "https://www.caa.si/en/geographical-restrictions-for-uas.html";

export class CaasiFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CaasiFetchError";
  }
}

function pickZipHref(html: string): string | null {
  const hrefs = [
    ...html.matchAll(/href="([^"]+\.zip)"/gi),
  ].map((m) => m[1].replace(/&amp;/g, "&"));
  if (hrefs.length === 0) return null;
  hrefs.sort();
  return hrefs[hrefs.length - 1] ?? null;
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  let fileUrl = CAASI_ZONES_PAGE;
  try {
    const index = await fetch(CAASI_ZONES_PAGE, {
      headers: { Accept: "text/html", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!index.ok) {
      throw new CaasiFetchError(
        `HTTP ${index.status}`,
        CAASI_ZONES_PAGE,
        index.status,
      );
    }
    const href = pickZipHref(await index.text());
    if (!href) {
      throw new CaasiFetchError(
        "no ZIP link on CAA SI UAS page",
        CAASI_ZONES_PAGE,
      );
    }
    fileUrl = new URL(href, CAASI_ZONES_PAGE).toString();
    const response = await fetch(fileUrl, {
      headers: { Accept: "application/zip,*/*", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new CaasiFetchError(
        `HTTP ${response.status}`,
        fileUrl,
        response.status,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    const kml = unzipFirstKml(buf);
    return parseKmlUasZones(kml, {
      fallbackCountry: "SVN",
      mapRestriction: sloveniaRestriction,
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new CaasiFetchError("caasi timeout", fileUrl, undefined, err);
    }
    throw err instanceof CaasiFetchError
      ? err
      : new CaasiFetchError(String(err), fileUrl, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "caasi",
  country: "SI",
  fetchZones: fetchNationalZones,
});

export const queryCaasiPoint = client.queryPoint.bind(client);
export const queryCaasiBbox = client.queryBbox.bind(client);
