/**
 * Latvian UAS geographical zones via LGS / drz.lv ED-269 JSON
 * (https://ais.lgs.lv/page/UAS_geozones — export list on drz.lv).
 */
import type { UasZoneFeature } from "@canifly/middleware";
import {
  createEd269NationalClient,
  isTimeout,
  parseEd269Payload,
} from "./ed269-national-cache";

const LGS_EXPORT_LIST = "https://drz.lv/api/v1/export-history/iframe-eng";
const LGS_EXPORT_LATEST = "https://drz.lv/api/v1/export-history/UASZoneVersion";

export class LgsFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LgsFetchError";
  }
}

function pickLatestExportHref(html: string): string | null {
  const hrefs = [
    ...html.matchAll(/href="(https:\/\/drz\.lv\/api\/v1\/export-history\/[^"]+)"/gi),
  ].map((m) => m[1]);
  if (hrefs.length === 0) return null;
  // Prefer the stable UASZoneVersion endpoint when listed.
  const version = hrefs.find((h) => /UASZoneVersion\/?$/i.test(h.replace(/\/$/, "")));
  if (version) return version;
  hrefs.sort();
  return hrefs[hrefs.length - 1] ?? null;
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  let fileUrl = LGS_EXPORT_LATEST;
  try {
    try {
      const index = await fetch(LGS_EXPORT_LIST, {
        headers: { Accept: "text/html,application/json", "User-Agent": "CanIFly/0.3" },
        signal: AbortSignal.timeout(20_000),
      });
      if (index.ok) {
        const href = pickLatestExportHref(await index.text());
        if (href) fileUrl = href;
      }
    } catch {
      // Fall through to stable UASZoneVersion URL.
    }

    const response = await fetch(fileUrl, {
      headers: { Accept: "application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new LgsFetchError(`HTTP ${response.status}`, fileUrl, response.status);
    }
    const text = await response.text();
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    return parseEd269Payload(data, "LVA");
  } catch (err) {
    if (isTimeout(err)) {
      throw new LgsFetchError("lgs timeout", fileUrl, undefined, err);
    }
    throw err instanceof LgsFetchError
      ? err
      : new LgsFetchError(String(err), fileUrl, undefined, err);
  }
}

const client = createEd269NationalClient({
  source: "lgs",
  country: "LV",
  fetchZones: fetchNationalZones,
});

export const queryLgsPoint = client.queryPoint.bind(client);
export const queryLgsBbox = client.queryBbox.bind(client);
