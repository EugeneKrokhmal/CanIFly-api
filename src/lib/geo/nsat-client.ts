/**
 * Slovak UAS geographical zones via NSAT / Dopravný úrad KML ZIP
 * (https://letectvo.nsat.sk/en/unmanned-aviation/geo-zones/).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
  unzipFirstKml,
} from "./ed269-national-cache";
import { parseKmlUasZones, slovakiaRestriction } from "./kml-zones";

const NSAT_ZONES_PAGE =
  "https://letectvo.nsat.sk/en/unmanned-aviation/geo-zones/";

export class NsatFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NsatFetchError";
  }
}

function pickLatestZipHref(html: string): string | null {
  const hrefs = [
    ...html.matchAll(
      /href="(https?:\/\/[^"]+\.zip|\/[^"]+\.zip)"/gi,
    ),
  ].map((m) => m[1].replace(/&amp;/g, "&"));
  if (hrefs.length === 0) return null;
  hrefs.sort();
  return hrefs[hrefs.length - 1] ?? null;
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  let fileUrl = NSAT_ZONES_PAGE;
  try {
    const index = await fetch(NSAT_ZONES_PAGE, {
      headers: {
        Accept: "text/html",
        "User-Agent": "CanIFly/0.3",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!index.ok) {
      throw new NsatFetchError(
        `HTTP ${index.status}`,
        NSAT_ZONES_PAGE,
        index.status,
      );
    }
    const href = pickLatestZipHref(await index.text());
    if (!href) {
      throw new NsatFetchError("no ZIP link on NSAT geo-zones page", NSAT_ZONES_PAGE);
    }
    const resolved = new URL(href, NSAT_ZONES_PAGE);
    // Publishers sometimes link http:// with non-ASCII path segments.
    resolved.protocol = "https:";
    resolved.pathname = resolved.pathname
      .split("/")
      .map((seg) => {
        try {
          return encodeURIComponent(decodeURIComponent(seg));
        } catch {
          return encodeURIComponent(seg);
        }
      })
      .join("/");
    fileUrl = resolved.toString();
    const response = await fetch(fileUrl, {
      headers: { Accept: "application/zip,*/*", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new NsatFetchError(`HTTP ${response.status}`, fileUrl, response.status);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    const kml = unzipFirstKml(buf);
    return parseKmlUasZones(kml, {
      fallbackCountry: "SVK",
      mapRestriction: slovakiaRestriction,
      idFromDescription: (desc, name) => {
        const m = desc.match(
          /Označenie<\/td>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i,
        );
        return (m?.[1] ?? name).trim();
      },
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new NsatFetchError("nsat timeout", fileUrl, undefined, err);
    }
    throw err instanceof NsatFetchError
      ? err
      : new NsatFetchError(String(err), fileUrl, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "nsat",
  country: "SK",
  fetchZones: fetchNationalZones,
});

export const queryNsatPoint = client.queryPoint.bind(client);
export const queryNsatBbox = client.queryBbox.bind(client);
