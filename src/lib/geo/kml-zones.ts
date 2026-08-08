/**
 * Minimal KML → UasZoneFeature parser for national UAS geozone downloads
 * (Slovakia NSAT, Slovenia CAA).
 */
import type {
  UasRestriction,
  UasZoneFeature,
  UasZoneGeometry,
} from "@canifly/middleware";

export type KmlRestrictionMapper = (ctx: {
  name: string;
  descriptionHtml: string;
  styleUrl: string;
}) => UasRestriction;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseCoordinates(block: string): GeoJSON.Position[] {
  const out: GeoJSON.Position[] = [];
  for (const token of block.trim().split(/\s+/)) {
    if (!token) continue;
    const [lngS, latS, altS] = token.split(",");
    const lng = Number(lngS);
    const lat = Number(latS);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const pos: GeoJSON.Position =
      altS != null && Number.isFinite(Number(altS))
        ? [lng, lat, Number(altS)]
        : [lng, lat];
    out.push(pos);
  }
  return out;
}

function closeRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  if (ring.length < 3) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return [...ring, a];
  return ring;
}

function polygonsFromPlacemark(body: string): GeoJSON.Polygon[] {
  const polys: GeoJSON.Polygon[] = [];
  for (const m of body.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/gi)) {
    const polyXml = m[0];
    const outer = polyXml.match(
      /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i,
    );
    if (!outer) continue;
    const outerRing = closeRing(parseCoordinates(outer[1]));
    if (outerRing.length < 4) continue;
    const inners: GeoJSON.Position[][] = [];
    for (const im of polyXml.matchAll(
      /<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi,
    )) {
      const ring = closeRing(parseCoordinates(im[1]));
      if (ring.length >= 4) inners.push(ring);
    }
    polys.push({ type: "Polygon", coordinates: [outerRing, ...inners] });
  }
  return polys;
}

function parseHeightBand(descriptionHtml: string): {
  lower: number;
  upper: number;
} {
  const plain = descriptionHtml.replace(/<[^>]+>/g, " ");
  // "30m - 120m AGL" / "GND - 120m AGL" / "Height AGL in meters … 150"
  const range = plain.match(
    /(?:GND|0\s*(?:ft|m)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*m\s*AGL/i,
  );
  if (range) return { lower: 0, upper: Number(range[1]) };
  const range2 = plain.match(
    /(\d+(?:\.\d+)?)\s*m\s*[-–]\s*(\d+(?:\.\d+)?)\s*m\s*AGL/i,
  );
  if (range2) return { lower: Number(range2[1]), upper: Number(range2[2]) };
  const heightCell = plain.match(
    /Height AGL in meters\s+(\d+(?:\.\d+)?)/i,
  );
  if (heightCell) return { lower: 0, upper: Number(heightCell[1]) };
  const višina = plain.match(
    /Višina nad tlemi v m\s+(\d+(?:\.\d+)?)/i,
  );
  if (višina) return { lower: 0, upper: Number(višina[1]) };
  return { lower: 0, upper: 120 };
}

function tableCell(descriptionHtml: string, label: string): string | null {
  const re = new RegExp(
    `<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>\\s*([^<]+)\\s*</td>`,
    "i",
  );
  const m = descriptionHtml.match(re);
  return m ? decodeXml(m[1]).trim() : null;
}

export const slovakiaRestriction: KmlRestrictionMapper = ({
  descriptionHtml,
}) => {
  const title = (
    descriptionHtml.match(/font-size:16px[^>]*>\s*([^<]+)/i)?.[1] ?? ""
  ).toUpperCase();
  if (title.includes("ZAKÁZ") || title.includes("ZAKAZ")) return "PROHIBITED";
  if (title.includes("OBMEDZEN")) return "REQ_AUTHORISATION";
  if (title.includes("AMC")) return "REQ_AUTHORISATION";
  const id = tableCell(descriptionHtml, "Označenie") ?? "";
  if (/^PUAS/i.test(id)) return "PROHIBITED";
  return "REQ_AUTHORISATION";
};

export const sloveniaRestriction: KmlRestrictionMapper = ({
  descriptionHtml,
}) => {
  const en = (tableCell(descriptionHtml, "Restrict") ?? "").toLowerCase();
  const sl = (tableCell(descriptionHtml, "omejitev") ?? "").toLowerCase();
  const blob = `${en} ${sl}`;
  if (blob.includes("prohibit") || blob.includes("prepoved")) {
    return "PROHIBITED";
  }
  if (
    blob.includes("dovoljeno") ||
    blob.includes("permit") ||
    blob.includes("conditional")
  ) {
    return "CONDITIONAL";
  }
  // Majority of CAA SI zones are hard no-fly when unlabeled.
  return "PROHIBITED";
};

export function parseKmlUasZones(
  kml: string,
  opts: {
    fallbackCountry: string;
    mapRestriction: KmlRestrictionMapper;
    idFromDescription?: (descriptionHtml: string, name: string) => string;
  },
): UasZoneFeature[] {
  const out: UasZoneFeature[] = [];
  let i = 0;
  for (const m of kml.matchAll(/<Placemark\b([^>]*)>([\s\S]*?)<\/Placemark>/gi)) {
    i += 1;
    const body = m[2];
    const nameMatch = body.match(/<name>([\s\S]*?)<\/name>/i);
    const name = nameMatch ? decodeXml(nameMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : `zone-${i}`;
    const descMatch = body.match(/<description>([\s\S]*?)<\/description>/i);
    const descriptionHtml = descMatch
      ? decodeXml(descMatch[1].replace(/<!\[CDATA\[|\]\]>/g, ""))
      : "";
    const styleUrl =
      body.match(/<styleUrl>([^<]+)<\/styleUrl>/i)?.[1]?.trim() ?? "";
    const polys = polygonsFromPlacemark(body);
    if (polys.length === 0) continue;

    const geom: GeoJSON.Polygon | GeoJSON.MultiPolygon =
      polys.length === 1
        ? polys[0]
        : { type: "MultiPolygon", coordinates: polys.map((p) => p.coordinates) };

    const { lower, upper } = parseHeightBand(descriptionHtml);
    const restriction = opts.mapRestriction({ name, descriptionHtml, styleUrl });
    const identifier =
      opts.idFromDescription?.(descriptionHtml, name) ||
      tableCell(descriptionHtml, "Označenie") ||
      tableCell(descriptionHtml, "naziv") ||
      name ||
      `zone-${i}`;

    const reason: string[] = [];
    const reasonEn = tableCell(descriptionHtml, "Reason");
    const reasonSl = tableCell(descriptionHtml, "Razlog");
    if (reasonEn) reason.push(reasonEn);
    else if (reasonSl) reason.push(reasonSl);

    const volume: UasZoneGeometry = {
      lowerLimit: lower,
      upperLimit: upper,
      uomDimensions: "M",
      lowerVerticalReference: "AGL",
      upperVerticalReference: "AGL",
      horizontalProjection: geom,
    };

    out.push({
      identifier: String(identifier).trim(),
      country: opts.fallbackCountry,
      name,
      type: "COMMON",
      restriction,
      reason,
      message: descriptionHtml
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500),
      geometry: [volume],
    });
  }
  return out;
}
