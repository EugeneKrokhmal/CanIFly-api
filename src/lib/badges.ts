/**
 * Pilot badges — computed on read from flights + pins + profile.
 * IDs must stay stable; frontend maps them via i18n (`pilot.badge.*`).
 */

export type PilotBadgeId =
  | "joined"
  | "first_flight"
  | "flights_10"
  | "distance_10km"
  | "distance_100km"
  | "airtime_1h"
  | "high_flyer"
  | "gps_track"
  | "first_pin"
  | "pins_10"
  | "fly_spot"
  | "photo_pin"
  | "operator";

export type PilotBadge = {
  id: PilotBadgeId;
  earned: boolean;
  /** ISO timestamp when first unlocked, if known */
  earnedAt: string | null;
};

export type BadgeFlightInput = {
  startedAt: Date | string;
  durationS: number;
  distanceM: number;
  maxHeightM: number | null;
  hasTrack: boolean;
};

export type BadgePinInput = {
  kind: string;
  photoUrl: string | null;
  createdAt: Date | string;
};

export type BadgePilotInput = {
  operatorNumber: string | null;
  avatarUrl: string | null;
  bio: string | null;
  /** Account creation time — unlocks the `joined` badge. */
  createdAt?: Date | string | null;
};

type Rule = {
  id: PilotBadgeId;
  test: (ctx: {
    flights: BadgeFlightInput[];
    pins: BadgePinInput[];
    pilot: BadgePilotInput;
    flightCount: number;
    pinCount: number;
    totalDistanceM: number;
    totalDurationS: number;
    maxHeightM: number;
  }) => boolean;
  /** Earliest event that unlocks the badge, for sorting */
  earnedAt: (ctx: {
    flights: BadgeFlightInput[];
    pins: BadgePinInput[];
    pilot: BadgePilotInput;
  }) => Date | null;
};

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function earliest(
  dates: Array<Date | string | null | undefined>,
): Date | null {
  let best: Date | null = null;
  for (const raw of dates) {
    const d = asDate(raw);
    if (!d) continue;
    if (!best || d.getTime() < best.getTime()) best = d;
  }
  return best;
}

const RULES: Rule[] = [
  {
    id: "joined",
    /** Any persisted pilot profile = account created. */
    test: () => true,
    earnedAt: ({ pilot }) => asDate(pilot.createdAt),
  },
  {
    id: "first_flight",
    test: ({ flightCount }) => flightCount >= 1,
    earnedAt: ({ flights }) =>
      earliest(flights.map((f) => f.startedAt)),
  },
  {
    id: "flights_10",
    test: ({ flightCount }) => flightCount >= 10,
    earnedAt: ({ flights }) => {
      const sorted = [...flights]
        .map((f) => asDate(f.startedAt))
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => a.getTime() - b.getTime());
      return sorted[9] ?? null;
    },
  },
  {
    id: "distance_10km",
    test: ({ totalDistanceM }) => totalDistanceM >= 10_000,
    earnedAt: ({ flights }) =>
      earliest(flights.map((f) => f.startedAt)),
  },
  {
    id: "distance_100km",
    test: ({ totalDistanceM }) => totalDistanceM >= 100_000,
    earnedAt: ({ flights }) =>
      earliest(flights.map((f) => f.startedAt)),
  },
  {
    id: "airtime_1h",
    test: ({ totalDurationS }) => totalDurationS >= 3600,
    earnedAt: ({ flights }) =>
      earliest(flights.map((f) => f.startedAt)),
  },
  {
    id: "high_flyer",
    test: ({ maxHeightM }) => maxHeightM >= 120,
    earnedAt: ({ flights }) =>
      earliest(
        flights
          .filter((f) => (f.maxHeightM ?? 0) >= 120)
          .map((f) => f.startedAt),
      ),
  },
  {
    id: "gps_track",
    test: ({ flights }) => flights.some((f) => f.hasTrack),
    earnedAt: ({ flights }) =>
      earliest(
        flights.filter((f) => f.hasTrack).map((f) => f.startedAt),
      ),
  },
  {
    id: "first_pin",
    test: ({ pinCount }) => pinCount >= 1,
    earnedAt: ({ pins }) => earliest(pins.map((p) => p.createdAt)),
  },
  {
    id: "pins_10",
    test: ({ pinCount }) => pinCount >= 10,
    earnedAt: ({ pins }) => {
      const sorted = [...pins]
        .map((p) => asDate(p.createdAt))
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => a.getTime() - b.getTime());
      return sorted[9] ?? null;
    },
  },
  {
    id: "fly_spot",
    test: ({ pins }) => pins.some((p) => p.kind === "fly_spot"),
    earnedAt: ({ pins }) =>
      earliest(
        pins
          .filter((p) => p.kind === "fly_spot")
          .map((p) => p.createdAt),
      ),
  },
  {
    id: "photo_pin",
    test: ({ pins }) => pins.some((p) => Boolean(p.photoUrl)),
    earnedAt: ({ pins }) =>
      earliest(
        pins.filter((p) => p.photoUrl).map((p) => p.createdAt),
      ),
  },
  {
    id: "operator",
    test: ({ pilot }) => Boolean(pilot.operatorNumber?.trim()),
    earnedAt: () => null,
  },
];

export const BADGE_CATALOG: PilotBadgeId[] = RULES.map((r) => r.id);

export function computePilotBadges(input: {
  pilot: BadgePilotInput;
  flights: BadgeFlightInput[];
  pins: BadgePinInput[];
}): PilotBadge[] {
  const flights = input.flights;
  const pins = input.pins;
  const flightCount = flights.length;
  const pinCount = pins.length;
  const totalDistanceM = flights.reduce(
    (s, f) => s + (Number.isFinite(f.distanceM) ? f.distanceM : 0),
    0,
  );
  const totalDurationS = flights.reduce(
    (s, f) => s + (Number.isFinite(f.durationS) ? f.durationS : 0),
    0,
  );
  const maxHeightM = flights.reduce((m, f) => {
    const h = f.maxHeightM;
    return h != null && Number.isFinite(h) && h > m ? h : m;
  }, 0);

  const ctx = {
    flights,
    pins,
    pilot: input.pilot,
    flightCount,
    pinCount,
    totalDistanceM,
    totalDurationS,
    maxHeightM,
  };

  const badges = RULES.map((rule) => {
    const earned = rule.test(ctx);
    const at = earned ? rule.earnedAt({ flights, pins, pilot: input.pilot }) : null;
    return {
      id: rule.id,
      earned,
      earnedAt: at ? at.toISOString() : null,
    } satisfies PilotBadge;
  });

  // Earned first (oldest unlock first), then locked in catalog order
  return badges.sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    if (a.earned && b.earned) {
      const ta = a.earnedAt ? Date.parse(a.earnedAt) : Number.POSITIVE_INFINITY;
      const tb = b.earnedAt ? Date.parse(b.earnedAt) : Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
    }
    return BADGE_CATALOG.indexOf(a.id) - BADGE_CATALOG.indexOf(b.id);
  });
}

export function pilotBadgeStats(input: {
  flights: BadgeFlightInput[];
  pins: BadgePinInput[];
}) {
  const totalDistanceM = input.flights.reduce(
    (s, f) => s + (Number.isFinite(f.distanceM) ? f.distanceM : 0),
    0,
  );
  const totalDurationS = input.flights.reduce(
    (s, f) => s + (Number.isFinite(f.durationS) ? f.durationS : 0),
    0,
  );
  return {
    flightCount: input.flights.length,
    pinCount: input.pins.length,
    totalDistanceM,
    totalDurationS,
  };
}
