import type { CountryId, MatchedZone } from "@canifly/middleware";
import {
  queryServaisBbox,
  queryServaisPoint,
} from "./enaire-client";
import {
  queryAnscrBbox,
  queryAnscrPoint,
} from "./anscr-client";
import {
  queryAnacBbox,
  queryAnacPoint,
} from "./anac-client";
import {
  queryAustroBbox,
  queryAustroPoint,
} from "./austro-client";
import {
  queryDipulBbox,
  queryDipulPoint,
} from "./dipul-client";
import {
  queryDronezonerBbox,
  queryDronezonerPoint,
} from "./dronezoner-client";
import {
  queryFocaBbox,
  queryFocaPoint,
} from "./foca-client";
import {
  queryGeopfBbox,
  queryGeopfPoint,
} from "./geopf-client";
import {
  queryLfvBbox,
  queryLfvPoint,
} from "./lfv-client";
import {
  queryIaaBbox,
  queryIaaPoint,
} from "./iaa-client";
import {
  queryLgsBbox,
  queryLgsPoint,
} from "./lgs-client";
import {
  queryAnsltBbox,
  queryAnsltPoint,
} from "./anslt-client";
import {
  queryEansBbox,
  queryEansPoint,
} from "./eans-client";
import {
  queryNsatBbox,
  queryNsatPoint,
} from "./nsat-client";
import {
  queryCaasiBbox,
  queryCaasiPoint,
} from "./caasi-client";
import {
  queryPansaBbox,
  queryPansaPoint,
} from "./pansa-client";

export interface CountryAirspaceProvider {
  country: CountryId;
  queryPoint(lat: number, lng: number, altitudeAgl?: number): Promise<MatchedZone[]>;
  queryBbox(
    west: number,
    south: number,
    east: number,
    north: number,
    limit?: number,
    altitudeAgl?: number,
  ): Promise<GeoJSON.FeatureCollection>;
}

export type LiveBackendLabel =
  | "servais"
  | "pansa"
  | "aimgis"
  | "dipul"
  | "geopf"
  | "dronezoner"
  | "foca"
  | "anac"
  | "austro"
  | "lfv"
  | "iaa"
  | "lgs"
  | "anslt"
  | "eans"
  | "nsat"
  | "caasi";

/** Live-only countries (no PostGIS/memory fallback). */
export const LIVE_ONLY_COUNTRIES = new Set<CountryId>([
  "PL",
  "CZ",
  // DE is PostGIS-first for map (synced dipul); point stays live with PostGIS fallback.
  "FR",
  "DK",
  "CH",
  "PT",
  "AT",
  "SE",
  "IE",
  "LV",
  "LT",
  "EE",
  "SK",
  "SI",
]);

export function backendLabelForCountry(country: CountryId): LiveBackendLabel {
  if (country === "PL") return "pansa";
  if (country === "CZ") return "aimgis";
  if (country === "DE") return "dipul";
  if (country === "FR") return "geopf";
  if (country === "DK") return "dronezoner";
  if (country === "CH") return "foca";
  if (country === "PT") return "anac";
  if (country === "AT") return "austro";
  if (country === "SE") return "lfv";
  if (country === "IE") return "iaa";
  if (country === "LV") return "lgs";
  if (country === "LT") return "anslt";
  if (country === "EE") return "eans";
  if (country === "SK") return "nsat";
  if (country === "SI") return "caasi";
  return "servais";
}

export const spainProvider: CountryAirspaceProvider = {
  country: "ES",
  async queryPoint(lat, lng) {
    return queryServaisPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryServaisBbox(west, south, east, north, limit);
  },
};

export const germanyProvider: CountryAirspaceProvider = {
  country: "DE",
  async queryPoint(lat, lng) {
    return queryDipulPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryDipulBbox(west, south, east, north, limit);
  },
};

export const franceProvider: CountryAirspaceProvider = {
  country: "FR",
  async queryPoint(lat, lng) {
    return queryGeopfPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryGeopfBbox(west, south, east, north, limit);
  },
};

export const denmarkProvider: CountryAirspaceProvider = {
  country: "DK",
  async queryPoint(lat, lng) {
    return queryDronezonerPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryDronezonerBbox(west, south, east, north, limit);
  },
};

export const switzerlandProvider: CountryAirspaceProvider = {
  country: "CH",
  async queryPoint(lat, lng) {
    return queryFocaPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryFocaBbox(west, south, east, north, limit);
  },
};

export const portugalProvider: CountryAirspaceProvider = {
  country: "PT",
  async queryPoint(lat, lng) {
    return queryAnacPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryAnacBbox(west, south, east, north, limit);
  },
};

export const austriaProvider: CountryAirspaceProvider = {
  country: "AT",
  async queryPoint(lat, lng) {
    return queryAustroPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryAustroBbox(west, south, east, north, limit);
  },
};

export const swedenProvider: CountryAirspaceProvider = {
  country: "SE",
  async queryPoint(lat, lng) {
    return queryLfvPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryLfvBbox(west, south, east, north, limit);
  },
};

export const irelandProvider: CountryAirspaceProvider = {
  country: "IE",
  async queryPoint(lat, lng) {
    return queryIaaPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryIaaBbox(west, south, east, north, limit);
  },
};

export const latviaProvider: CountryAirspaceProvider = {
  country: "LV",
  async queryPoint(lat, lng) {
    return queryLgsPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryLgsBbox(west, south, east, north, limit);
  },
};

export const lithuaniaProvider: CountryAirspaceProvider = {
  country: "LT",
  async queryPoint(lat, lng) {
    return queryAnsltPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryAnsltBbox(west, south, east, north, limit);
  },
};

export const estoniaProvider: CountryAirspaceProvider = {
  country: "EE",
  async queryPoint(lat, lng) {
    return queryEansPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryEansBbox(west, south, east, north, limit);
  },
};

export const slovakiaProvider: CountryAirspaceProvider = {
  country: "SK",
  async queryPoint(lat, lng) {
    return queryNsatPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryNsatBbox(west, south, east, north, limit);
  },
};

export const sloveniaProvider: CountryAirspaceProvider = {
  country: "SI",
  async queryPoint(lat, lng) {
    return queryCaasiPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryCaasiBbox(west, south, east, north, limit);
  },
};

export const czechiaProvider: CountryAirspaceProvider = {
  country: "CZ",
  async queryPoint(lat, lng) {
    return queryAnscrPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryAnscrBbox(west, south, east, north, limit);
  },
};

export const polandProvider: CountryAirspaceProvider = {
  country: "PL",
  async queryPoint(lat, lng, altitudeAgl = 120) {
    return queryPansaPoint(lat, lng, altitudeAgl);
  },
  async queryBbox(west, south, east, north, limit = 500, altitudeAgl = 120) {
    return queryPansaBbox(west, south, east, north, limit, altitudeAgl);
  },
};

export const COUNTRY_PROVIDERS: Record<CountryId, CountryAirspaceProvider> = {
  ES: spainProvider,
  DE: germanyProvider,
  FR: franceProvider,
  DK: denmarkProvider,
  CH: switzerlandProvider,
  PT: portugalProvider,
  AT: austriaProvider,
  CZ: czechiaProvider,
  PL: polandProvider,
  SE: swedenProvider,
  IE: irelandProvider,
  LV: latviaProvider,
  LT: lithuaniaProvider,
  EE: estoniaProvider,
  SK: slovakiaProvider,
  SI: sloveniaProvider,
};

export function getProvider(country: CountryId): CountryAirspaceProvider {
  return COUNTRY_PROVIDERS[country];
}
