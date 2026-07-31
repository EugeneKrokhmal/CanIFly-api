import {
  DEFAULT_DRONE_PROFILE,
  type AirspaceStatus,
} from "@canifly/middleware";
import { eq, inArray, like } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { evaluateAirspaceStatus } from "../db/queries.js";
import { getDb } from "../db/client.js";
import { obstacles, obstacleVotes, users } from "../db/schema.js";

export const SEED_EMAIL_SUFFIX = "@seed.canifly.local";
export const SEED_PASSWORD = "SeedPilot2026!";

const OPEN_PROFILE = DEFAULT_DRONE_PROFILE;
const CEILING_AGL = 120;

type FlySpotSeed = {
  type: "park" | "beach" | "field" | "rooftop" | "other";
  lat: number;
  lng: number;
  message: string;
};

type PilotSeed = {
  email: string;
  name: string;
  locale: "es" | "cs" | "pl";
  bio: string;
  spots: FlySpotSeed[];
};

/** Rural / scenic coords — away from CTR, city cores, and airport buffers. */
const PILOTS: PilotSeed[] = [
  {
    email: `ana.mancha${SEED_EMAIL_SUFFIX}`,
    name: "Ana Rodríguez",
    locale: "es",
    bio: "Campos abiertos en Castilla-La Mancha. Siempre VLOS y lejos de aeródromos.",
    spots: [
      { type: "field", lat: 41.05, lng: -4.48, message: "Dehesa al sur de Segovia" },
      { type: "field", lat: 40.82, lng: -3.92, message: "Pradera sin edificios, Jarama alto" },
    ],
  },
  {
    email: `carlos.costa${SEED_EMAIL_SUFFIX}`,
    name: "Carlos Martínez",
    locale: "es",
    bio: "Calas y dunas fuera de temporada, lejos de ciudades costeras.",
    spots: [
      { type: "beach", lat: 36.72, lng: -2.19, message: "Playa de los Genoveses, Cabo de Gata" },
      { type: "beach", lat: 41.85, lng: 3.12, message: "Cala Cap de Creus, Empordà (lado sur)" },
      { type: "field", lat: 39.48, lng: -6.35, message: "Dehesa cerca de Trujillo" },
    ],
  },
  {
    email: `lucia.galicia${SEED_EMAIL_SUFFIX}`,
    name: "Lucía Fernández",
    locale: "es",
    bio: "Interior y costa de Galicia, siempre comprobando ENAIRE antes de despegar.",
    spots: [
      { type: "beach", lat: 42.92, lng: -8.65, message: "Dunas de Laxe, Costa da Morte" },
      { type: "field", lat: 42.58, lng: -7.65, message: "Pradera de altura, O Courel" },
    ],
  },
  {
    email: `petr.bohemia${SEED_EMAIL_SUFFIX}`,
    name: "Petr Novák",
    locale: "cs",
    bio: "Jih Moravy a Slovácko, louky mimo zastavěnou oblast.",
    spots: [
      { type: "field", lat: 48.62, lng: 17.15, message: "Vinice u Mutěnic" },
      { type: "field", lat: 48.58, lng: 17.22, message: "Luka u rybníka, Břeclavsko" },
      { type: "field", lat: 49.15, lng: 15.12, message: "Rákosí u Nových Hradů, Třeboň" },
    ],
  },
  {
    email: `jana.morava${SEED_EMAIL_SUFFIX}`,
    name: "Jana Kučerová",
    locale: "cs",
    bio: "Jižní Morava, vinice a louky mimo zastavěnou oblast.",
    spots: [
      { type: "field", lat: 48.92, lng: 16.42, message: "Trať mezi vinicemi, Pálava" },
      { type: "field", lat: 48.85, lng: 16.88, message: "Luka u Baťova kanálu" },
    ],
  },
  {
    email: `tomas.bohemia${SEED_EMAIL_SUFFIX}`,
    name: "Tomáš Veselý",
    locale: "cs",
    bio: "Rybníky a lesní mýtiny na jihu a severozápadě republiky.",
    spots: [
      { type: "field", lat: 48.81, lng: 14.35, message: "Louka pod hradem, jižní břeh" },
      { type: "field", lat: 49.15, lng: 15.12, message: "Rákosí u Nových Hradů, Třeboň" },
      { type: "field", lat: 48.92, lng: 16.42, message: "Trať mezi vinicemi, Pálava" },
      { type: "field", lat: 48.85, lng: 16.88, message: "Luka u Baťova kanálu" },
    ],
  },
  {
    email: `kasia.mazury${SEED_EMAIL_SUFFIX}`,
    name: "Kasia Wiśniewska",
    locale: "pl",
    bio: "Mazury i Podlasie, jeziora i łąki z dala od EPWA.",
    spots: [
      { type: "field", lat: 53.82, lng: 21.58, message: "Łąka nad taflą jeziora, Mikołajki" },
      { type: "field", lat: 52.98, lng: 23.15, message: "Polana przy Puszczy" },
    ],
  },
  {
    email: `marek.coast${SEED_EMAIL_SUFFIX}`,
    name: "Marek Dąbrowski",
    locale: "pl",
    bio: "Równiny Mazowsza i Kujaw, łąki z dala od dużych miast.",
    spots: [
      { type: "field", lat: 52.873, lng: 20.579, message: "Łąka koło Mławy" },
      { type: "field", lat: 52.867, lng: 20.507, message: "Polana przy lesie" },
      { type: "field", lat: 53.207, lng: 20.018, message: "Pastwisko nad jeziorem, Warmia" },
    ],
  },
  {
    email: `zofia.south${SEED_EMAIL_SUFFIX}`,
    name: "Zofia Lewandowska",
    locale: "pl",
    bio: "Podkarpacie i Beskid Niski, górskie łąki poza strefami miast.",
    spots: [
      { type: "field", lat: 49.65, lng: 20.75, message: "Polana nad doliną, Beskid Niski" },
      { type: "field", lat: 53.72, lng: 21.42, message: "Zatoczka Giżycko" },
      { type: "field", lat: 52.873, lng: 20.579, message: "Łąka koło Mławy" },
      { type: "field", lat: 53.82, lng: 21.58, message: "Łąka nad taflą jeziora, Mikołajki" },
      { type: "field", lat: 52.98, lng: 23.15, message: "Polana przy Puszczy" },
    ],
  },
];

const ALLOWED_STATUSES = new Set<AirspaceStatus>(["clear", "limited"]);

async function filterSpotsByAirspace(
  spots: FlySpotSeed[],
): Promise<{ kept: FlySpotSeed[]; rejected: string[] }> {
  const kept: FlySpotSeed[] = [];
  const rejected: string[] = [];

  for (const spot of spots) {
    try {
      const { result } = await evaluateAirspaceStatus(
        spot.lat,
        spot.lng,
        OPEN_PROFILE,
        CEILING_AGL,
      );
      if (ALLOWED_STATUSES.has(result.status)) {
        kept.push(spot);
      } else {
        rejected.push(
          `${spot.message} → ${result.status} (${spot.lat}, ${spot.lng})`,
        );
      }
    } catch {
      // Offline / provider error — keep pre-vetted rural coords.
      kept.push(spot);
    }
  }

  return { kept, rejected };
}

export type SeedPilotsResult = {
  skipped: boolean;
  pilots: number;
  flySpots: number;
  votes: number;
  removed?: number;
  existingEmails?: string[];
  rejectedSpots?: string[];
};

async function removeExistingSeedUsers(db: ReturnType<typeof getDb>["db"]) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${SEED_EMAIL_SUFFIX}`));
  if (existing.length === 0) return 0;
  for (const row of existing) {
    await db.delete(users).where(eq(users.id, row.id));
  }
  return existing.length;
}

export function seedPilotsPlan() {
  return {
    pilots: PILOTS.length,
    flySpots: PILOTS.reduce((n, p) => n + p.spots.length, 0),
    emailSuffix: SEED_EMAIL_SUFFIX,
  };
}

/** Re-seed when stored copy still uses em/en dashes (legacy AI-ish seed text). */
export async function seedNeedsRefresh(): Promise<boolean> {
  const { db } = getDb();
  const seedUsers = await db
    .select({ id: users.id, bio: users.bio })
    .from(users)
    .where(like(users.email, `%${SEED_EMAIL_SUFFIX}`));

  if (seedUsers.length === 0) return false;

  const dash = /[—–]/;
  if (seedUsers.some((u) => dash.test(u.bio ?? ""))) return true;

  const seedIds = seedUsers.map((u) => u.id);
  const pins = await db
    .select({ message: obstacles.message })
    .from(obstacles)
    .where(inArray(obstacles.userId, seedIds));

  return pins.some((p) => dash.test(p.message ?? ""));
}

export async function seedPilots(options: {
  force?: boolean;
} = {}): Promise<SeedPilotsResult> {
  const { force = false } = options;
  const { db } = getDb();

  const existing = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(like(users.email, `%${SEED_EMAIL_SUFFIX}`));

  if (existing.length > 0 && !force) {
    return {
      skipped: true,
      pilots: 0,
      flySpots: 0,
      votes: 0,
      existingEmails: existing.map((u) => u.email),
    };
  }

  let removed = 0;
  if (force && existing.length > 0) {
    removed = await removeExistingSeedUsers(db);
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const now = new Date();
  const insertedUserIds: string[] = [];
  let flySpots = 0;
  const rejectedSpots: string[] = [];
  let pilotsInserted = 0;

  for (const pilot of PILOTS) {
    const { kept, rejected } = await filterSpotsByAirspace(pilot.spots);
    rejectedSpots.push(...rejected);
    if (kept.length === 0) {
      console.warn(`[seed] skip ${pilot.name} — no clear/limited spots`);
      continue;
    }

    const [user] = await db
      .insert(users)
      .values({
        email: pilot.email,
        passwordHash,
        name: pilot.name,
        bio: pilot.bio,
        locale: pilot.locale,
        emailVerifiedAt: now,
      })
      .returning({ id: users.id });

    insertedUserIds.push(user.id);
    pilotsInserted++;

    for (const spot of kept) {
      await db.insert(obstacles).values({
        userId: user.id,
        kind: "fly_spot",
        type: spot.type,
        lat: spot.lat,
        lng: spot.lng,
        heightM: CEILING_AGL,
        message: spot.message,
      });
      flySpots++;
    }
  }

  let votes = 0;
  if (insertedUserIds.length >= 3) {
    const pinRows = await db
      .select({ id: obstacles.id, userId: obstacles.userId })
      .from(obstacles)
      .where(inArray(obstacles.userId, insertedUserIds));

    for (const pin of pinRows) {
      for (const voterId of insertedUserIds) {
        if (voterId === pin.userId) continue;
        if (Math.random() > 0.35) continue;
        await db.insert(obstacleVotes).values({
          obstacleId: pin.id,
          userId: voterId,
          value: "up",
        });
        votes++;
      }
    }
  }

  return {
    skipped: false,
    pilots: pilotsInserted,
    flySpots,
    votes,
    removed: removed || undefined,
    rejectedSpots: rejectedSpots.length > 0 ? rejectedSpots : undefined,
  };
}
