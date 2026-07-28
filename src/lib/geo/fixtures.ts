import type { UasZoneFeature } from "@canifly/middleware";

/**
 * Small synthetic ED-318 fixtures for offline demo / unit tests.
 * Coordinates are around Madrid / rural Castile for Clear / Restricted / Prohibited demos.
 */
export const FIXTURE_ZONES: UasZoneFeature[] = [
  {
    identifier: "ES-PRO-MAD-CTR",
    country: "ESP",
    name: "Madrid CTR (demo)",
    type: "COMMON",
    restriction: "PROHIBITED",
    reason: ["AIR_TRAFFIC"],
    zoneAuthority: [
      { name: "AIS Demo", email: "ais@enaire.es", purpose: "AUTHORIZATION" },
    ],
    geometry: [
      {
        lowerLimit: 0,
        upperLimit: 1200,
        uomDimensions: "M",
        lowerVerticalReference: "AGL",
        upperVerticalReference: "AGL",
        horizontalProjection: {
          type: "Polygon",
          coordinates: [
            [
              [-3.72, 40.42],
              [-3.5, 40.42],
              [-3.5, 40.55],
              [-3.72, 40.55],
              [-3.72, 40.42],
            ],
          ],
        },
      },
    ],
  },
  {
    identifier: "ES-AUTH-URB-MAD",
    country: "ESP",
    name: "Madrid urban protection (demo)",
    type: "COMMON",
    restriction: "REQ_AUTHORISATION",
    reason: ["PRIVACY", "SECURITY"],
    zoneAuthority: [
      { name: "Municipal Demo", email: "drones@madrid.es", purpose: "AUTHORIZATION" },
    ],
    geometry: [
      {
        lowerLimit: 0,
        upperLimit: 120,
        uomDimensions: "M",
        lowerVerticalReference: "AGL",
        upperVerticalReference: "AGL",
        horizontalProjection: {
          type: "Polygon",
          coordinates: [
            [
              [-3.72, 40.38],
              [-3.65, 40.38],
              [-3.65, 40.42],
              [-3.72, 40.42],
              [-3.72, 40.38],
            ],
          ],
        },
      },
    ],
  },
  {
    identifier: "ES-MIL-HIGH",
    country: "ESP",
    name: "High-altitude military training (demo)",
    type: "COMMON",
    restriction: "PROHIBITED",
    reason: ["MILITARY"],
    geometry: [
      {
        lowerLimit: 500,
        upperLimit: 5000,
        uomDimensions: "M",
        lowerVerticalReference: "AGL",
        upperVerticalReference: "AGL",
        horizontalProjection: {
          type: "Polygon",
          coordinates: [
            [
              [-4.2, 40.0],
              [-3.9, 40.0],
              [-3.9, 40.3],
              [-4.2, 40.3],
              [-4.2, 40.0],
            ],
          ],
        },
      },
    ],
  },
  {
    identifier: "ES-COND-PARK",
    country: "ESP",
    name: "Conditional park zone (demo)",
    type: "COMMON",
    restriction: "CONDITIONAL",
    reason: ["NATURE"],
    geometry: [
      {
        lowerLimit: 0,
        upperLimit: 120,
        uomDimensions: "M",
        lowerVerticalReference: "AGL",
        upperVerticalReference: "AGL",
        horizontalProjection: {
          type: "Polygon",
          coordinates: [
            [
              [-3.7, 40.35],
              [-3.68, 40.35],
              [-3.68, 40.37],
              [-3.7, 40.37],
              [-3.7, 40.35],
            ],
          ],
        },
      },
    ],
  },
];

/** Known test points for Clear / Restricted / Prohibited scenarios. */
export const FIXTURE_TEST_POINTS = {
  prohibited: { lat: 40.48, lng: -3.6, label: "Madrid CTR" },
  restricted: { lat: 40.4, lng: -3.69, label: "Madrid urban" },
  clear: { lat: 41.0, lng: -4.5, label: "Rural Castile" },
  militaryHigh: { lat: 40.15, lng: -4.05, label: "Military high (filtered for open)" },
} as const;
