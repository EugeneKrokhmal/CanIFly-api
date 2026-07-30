/**
 * Austrian UAS geographical zones via Austro Control ED-269 ZIP/JSON
 * (https://www.austrocontrol.at/.../geografische_zonen).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
  parseEd269Payload,
  unzipFirstJson,
} from "./ed269-national-cache";

const AUSTRO_PAGE =
  "https://www.austrocontrol.at/luftfahrtbehoerde/lizenzen__bewilligungen/drohnen/geografische_zonen";
const AUSTRO_ORIGIN = "https://www.austrocontrol.at";

export class AustroFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AustroFetchError";
  }
}

function pickLatestDownload(html: string): string | null {
  const hrefs = [
    ...html.matchAll(
      /href="(\/jart\/prj3\/ac\/releases\/de\/upload\/Dronespace\/[^"]+\.(?:zip|json))"/gi,
    ),
  ].map((m) => m[1]);
  if (hrefs.length === 0) return null;
  // Prefer production packages; lexical last ≈ newest timestamp in filename.
  const production = hrefs.filter((h) => /production/i.test(h));
  const pool = production.length > 0 ? production : hrefs;
  pool.sort();
  return pool[pool.length - 1] ?? null;
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  let fileUrl = AUSTRO_PAGE;
  try {
    const page = await fetch(AUSTRO_PAGE, {
      headers: { Accept: "text/html", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!page.ok) {
      throw new AustroFetchError(`HTTP ${page.status}`, AUSTRO_PAGE, page.status);
    }
    const html = await page.text();
    const href = pickLatestDownload(html);
    if (!href) {
      throw new AustroFetchError("no ZIP/JSON download on Austro page", AUSTRO_PAGE);
    }
    fileUrl = new URL(href, AUSTRO_ORIGIN).toString();
    const response = await fetch(fileUrl, {
      headers: { Accept: "application/zip,application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new AustroFetchError(`HTTP ${response.status}`, fileUrl, response.status);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    const text = /\.json$/i.test(fileUrl)
      ? buf.toString("utf8")
      : unzipFirstJson(buf);
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    return parseEd269Payload(data, "AUT");
  } catch (err) {
    if (isTimeout(err)) {
      throw new AustroFetchError("austro timeout", fileUrl, undefined, err);
    }
    throw err instanceof AustroFetchError
      ? err
      : new AustroFetchError(String(err), fileUrl, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "austro",
  country: "AT",
  fetchZones: fetchNationalZones,
});

export const queryAustroPoint = client.queryPoint.bind(client);
export const queryAustroBbox = client.queryBbox.bind(client);
