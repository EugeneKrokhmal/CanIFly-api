#!/usr/bin/env tsx
/**
 * Seed demo pilots with scenic fly spots (ES / CZ / PL).
 *
 * Usage:
 *   npm run seed:pilots              # skip if seed users exist
 *   npm run seed:pilots -- --force   # delete prior seed users and re-insert
 *   npm run seed:pilots -- --dry-run # print plan only
 *
 * Seed accounts use @seed.canifly.local emails and password `SeedPilot2026!`
 */
import { config } from "dotenv";
config({ path: ".env" });

import { eq, inArray, like } from "drizzle-orm";
import { hashPassword } from "../src/lib/auth/password.js";
import {
  ensurePostgisSchema,
  getDb,
  isDatabaseAvailable,
} from "../src/lib/db/client.js";
import { obstacles, obstacleVotes, users } from "../src/lib/db/schema.js";

const SEED_EMAIL_SUFFIX = "@seed.canifly.local";
const SEED_PASSWORD = "SeedPilot2026!";

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

const PILOTS: PilotSeed[] = [
  {
    email: `ana.madrid${SEED_EMAIL_SUFFIX}`,
    name: "Ana R.",
    locale: "es",
    bio: "Vuelos VLOS en parques abiertos de Madrid.",
    spots: [
      { type: "park", lat: 40.4153, lng: -3.6844, message: "El Retiro — pradera sur, amanecer" },
      { type: "field", lat: 40.4521, lng: -3.7288, message: "Casa de Campo — zona abierta al oeste" },
    ],
  },
  {
    email: `carlos.costa${SEED_EMAIL_SUFFIX}`,
    name: "Carlos M.",
    locale: "es",
    bio: "Playas y acantilados en la costa mediterránea.",
    spots: [
      { type: "beach", lat: 36.7165, lng: -4.4073, message: "Málaga — La Malagueta, temprano" },
      { type: "beach", lat: 41.3789, lng: 2.1898, message: "Barceloneta — antes de las 9h" },
      { type: "park", lat: 41.4145, lng: 2.1527, message: "Parque Güell — mirador norte" },
    ],
  },
  {
    email: `lucia.galicia${SEED_EMAIL_SUFFIX}`,
    name: "Lucía P.",
    locale: "es",
    bio: "Rías y dunas en Galicia.",
    spots: [
      { type: "beach", lat: 42.5453, lng: -8.7261, message: "Pontevedra — playa de Mogán" },
      { type: "field", lat: 43.3623, lng: -8.4115, message: "Coruña — campo costero A Coruña" },
    ],
  },
  {
    email: `petr.praha${SEED_EMAIL_SUFFIX}`,
    name: "Petr N.",
    locale: "cs",
    bio: "Letiště v okolí Prahy — vždy kontrola DroneMap.",
    spots: [
      { type: "park", lat: 50.0936, lng: 14.4214, message: "Letná — výhled na centrum" },
      { type: "field", lat: 49.9399, lng: 14.1884, message: "Karlštejn — údolí pod hradem" },
      { type: "park", lat: 50.0807, lng: 14.3949, message: "Petřín — jižní svah" },
    ],
  },
  {
    email: `jana.brno${SEED_EMAIL_SUFFIX}`,
    name: "Jana K.",
    locale: "cs",
    bio: "Brno a jižní Morava.",
    spots: [
      { type: "field", lat: 49.2172, lng: 16.5734, message: "Brněnská přehrada — západní břeh" },
      { type: "park", lat: 49.1951, lng: 16.6088, message: "Lužánky — louka u tenisů" },
    ],
  },
  {
    email: `tomas.bohemia${SEED_EMAIL_SUFFIX}`,
    name: "Tomáš V.",
    locale: "cs",
    bio: "Jihočeské rybníky a lesní mýtiny.",
    spots: [
      { type: "field", lat: 48.7745, lng: 14.3173, message: "Český Krumlov — louka u Vltavy" },
      { type: "park", lat: 50.0755, lng: 14.4378, message: "Stromovka — severní louka" },
      { type: "field", lat: 49.1528, lng: 15.1194, message: "Třeboňsko — rákosí u rybníka" },
      { type: "other", lat: 50.8513, lng: 14.2533, message: "České Švýcarsko — Pravčická brána (okolí)" },
    ],
  },
  {
    email: `kasia.warsaw${SEED_EMAIL_SUFFIX}`,
    name: "Kasia W.",
    locale: "pl",
    bio: "Parki w Warszawie — zawsze sprawdzam strefę przed startem.",
    spots: [
      { type: "park", lat: 52.215, lng: 21.0354, message: "Łazienki — łąka przy pałacu" },
      { type: "field", lat: 52.2297, lng: 20.9858, message: "Bielany — Pola Mokotowskie" },
    ],
  },
  {
    email: `marek.coast${SEED_EMAIL_SUFFIX}`,
    name: "Marek D.",
    locale: "pl",
    bio: "Wybrzeże Bałtyku i klify.",
    spots: [
      { type: "beach", lat: 54.352, lng: 18.6466, message: "Gdańsk — plaża Stogi o świcie" },
      { type: "beach", lat: 54.5189, lng: 18.5305, message: "Hel — wydmy, poza sezonem" },
      { type: "field", lat: 54.4419, lng: 18.5601, message: "Sopot — łąka przy lesie" },
    ],
  },
  {
    email: `zofia.south${SEED_EMAIL_SUFFIX}`,
    name: "Zofia L.",
    locale: "pl",
    bio: "Kraków i Mazury.",
    spots: [
      { type: "park", lat: 50.0667, lng: 19.9244, message: "Kraków — Błonia" },
      { type: "field", lat: 53.848, lng: 21.552, message: "Mazury — łąka nad jeziorem" },
      { type: "park", lat: 50.0614, lng: 19.9372, message: "Kraków — Kopiec Kościuszki (okolice)" },
      { type: "field", lat: 49.9686, lng: 20.4303, message: "Tatry — Podhale, łąka pod Gubałówką" },
      { type: "beach", lat: 54.7958, lng: 18.3953, message: "Władysławowo — plaża północna" },
    ],
  },
];

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  const totalSpots = PILOTS.reduce((n, p) => n + p.spots.length, 0);
  console.log(
    `Plan: ${PILOTS.length} pilots, ${totalSpots} fly spots (${SEED_EMAIL_SUFFIX})`,
  );

  if (dryRun) {
    for (const p of PILOTS) {
      console.log(`  ${p.name} (${p.locale}) — ${p.spots.length} spots`);
    }
    return;
  }

  if (!(await isDatabaseAvailable())) {
    console.error("Database unavailable — check DATABASE_URL in .env");
    process.exit(1);
  }

  await ensurePostgisSchema();
  const { db } = getDb();

  const existing = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(like(users.email, `%${SEED_EMAIL_SUFFIX}`));

  if (existing.length > 0 && !force) {
    console.log(
      `Found ${existing.length} seed user(s). Run with --force to replace, or skip.`,
    );
    console.log("Existing:", existing.map((u) => u.email).join(", "));
    return;
  }

  if (force && existing.length > 0) {
    const removed = await removeExistingSeedUsers(db);
    console.log(`Removed ${removed} prior seed user(s).`);
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const now = new Date();
  const insertedUserIds: string[] = [];

  for (const pilot of PILOTS) {
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

    for (const spot of pilot.spots) {
      await db.insert(obstacles).values({
        userId: user.id,
        kind: "fly_spot",
        type: spot.type,
        lat: spot.lat,
        lng: spot.lng,
        heightM: 120,
        message: spot.message,
      });
    }

    console.log(`+ ${pilot.name} — ${pilot.spots.length} fly spot(s)`);
  }

  // Light cross-upvotes so Top Pilots looks alive.
  if (insertedUserIds.length >= 3) {
    const pinRows = await db
      .select({ id: obstacles.id, userId: obstacles.userId })
      .from(obstacles)
      .where(inArray(obstacles.userId, insertedUserIds));

    let votes = 0;
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
    console.log(`+ ${votes} cross-upvote(s)`);
  }

  console.log("\nDone.");
  console.log(`Login: any *${SEED_EMAIL_SUFFIX} / ${SEED_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
