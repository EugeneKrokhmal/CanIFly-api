import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

config({ path: ".env" });

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://canifly:canifly@localhost:5432/canifly";

declare global {
  var __caniflySql: ReturnType<typeof postgres> | undefined;
  var __caniflyDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
  var __caniflyDbAvailable: boolean | undefined;
  var __caniflyDbCheckedAt: number | undefined;
  var __caniflySchemaPromise: Promise<void> | undefined;
  var __caniflySchemaReady: boolean | undefined;
}

function useSsl(url: string): boolean | "require" {
  // Local Docker PostGIS has no TLS; Supabase / hosted Postgres need it.
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1") return false;
  } catch {
    /* keep require for odd URLs */
  }
  if (/sslmode=disable/i.test(url)) return false;
  return "require";
}

function createClient() {
  // Supabase transaction pooler (:6543) does not support prepared statements.
  // Session pooler / direct (:5432) works either way; prepare:false is safe for both.
  const sql = postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ssl: useSsl(connectionString),
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export function getDb() {
  if (!global.__caniflyDb || !global.__caniflySql) {
    const { sql, db } = createClient();
    global.__caniflySql = sql;
    global.__caniflyDb = db;
  }
  return { db: global.__caniflyDb, sql: global.__caniflySql };
}

const AVAILABILITY_TTL_MS = 30_000;

export async function isDatabaseAvailable(): Promise<boolean> {
  const now = Date.now();
  if (
    global.__caniflyDbAvailable !== undefined &&
    global.__caniflyDbCheckedAt !== undefined &&
    now - global.__caniflyDbCheckedAt < AVAILABILITY_TTL_MS
  ) {
    return global.__caniflyDbAvailable;
  }

  try {
    const { sql } = getDb();
    await sql`SELECT 1`;
    global.__caniflyDbAvailable = true;
  } catch (err) {
    console.error("[db] availability check failed:", err);
    global.__caniflyDbAvailable = false;
  }
  global.__caniflyDbCheckedAt = now;
  return global.__caniflyDbAvailable;
}

export function resetDatabaseAvailabilityCache(): void {
  global.__caniflyDbAvailable = undefined;
  global.__caniflyDbCheckedAt = undefined;
}

async function runPostgisSchemaMigrations(): Promise<void> {
  const { sql } = getDb();
  await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

  await sql`
    DO $$ BEGIN
      CREATE TYPE zone_source AS ENUM ('aero', 'urbano', 'infra', 'servais', 'fixture', 'pansa', 'anscr');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `;

  for (const value of ["pansa", "anscr"] as const) {
    await sql.unsafe(`
      DO $$ BEGIN
        ALTER TYPE zone_source ADD VALUE IF NOT EXISTS '${value}';
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  }
  await sql`
    CREATE TABLE IF NOT EXISTS uas_zone_slices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      zone_identifier text NOT NULL,
      name text NOT NULL,
      source zone_source NOT NULL,
      restriction text NOT NULL,
      reason text[] NOT NULL DEFAULT '{}',
      zone_type text NOT NULL DEFAULT 'COMMON',
      lower_limit_m double precision NOT NULL DEFAULT 0,
      upper_limit_m double precision NOT NULL DEFAULT 120,
      lower_ref text NOT NULL DEFAULT 'AGL',
      upper_ref text NOT NULL DEFAULT 'AGL',
      properties jsonb NOT NULL,
      geom geometry(MultiPolygon, 4326) NOT NULL,
      geom_wkt text NOT NULL DEFAULT '',
      valid_from timestamptz,
      valid_to timestamptz,
      ingested_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS uas_zone_slices_geom_gist
      ON uas_zone_slices USING GIST (geom);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS uas_zone_slices_restriction_idx
      ON uas_zone_slices (restriction);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS uas_zone_slices_source_idx
      ON uas_zone_slices (source);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS uas_zone_slices_zone_identifier_idx
      ON uas_zone_slices (zone_identifier);
  `;

  await sql`
    DO $$ BEGIN
      CREATE TYPE obstacle_type AS ENUM (
        'construction',
        'crane',
        'electric_line',
        'air_sports',
        'other'
      );
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `;

  for (const value of ["other", "park", "rooftop", "field", "beach"] as const) {
    await sql.unsafe(`
      DO $$ BEGIN
        ALTER TYPE obstacle_type ADD VALUE IF NOT EXISTS '${value}';
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  }

  await sql`
    DO $$ BEGIN
      CREATE TYPE pin_kind AS ENUM ('obstacle', 'fly_spot');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      name text NOT NULL DEFAULT '',
      operator_number text,
      bio text,
      avatar_url text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS operator_number text;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS bio text;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS avatar_url text;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'es';
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verify_token text;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verify_expires timestamptz;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_reset_token text;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_reset_expires timestamptz;
  `;
  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS google_id text;
  `;
  await sql`
    ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL;
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_uidx
      ON users (google_id)
      WHERE google_id IS NOT NULL;
  `;
  // Legacy accounts created before email verification: treat as verified.
  await sql`
    UPDATE users
    SET email_verified_at = COALESCE(email_verified_at, created_at)
    WHERE email_verified_at IS NULL
      AND email_verify_token IS NULL;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS obstacles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind pin_kind NOT NULL DEFAULT 'obstacle',
      type obstacle_type NOT NULL,
      lat double precision NOT NULL,
      lng double precision NOT NULL,
      height_m double precision NOT NULL,
      message text,
      photo_url text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  await sql`
    ALTER TABLE obstacles
      ADD COLUMN IF NOT EXISTS photo_url text;
  `;

  await sql`
    ALTER TABLE obstacles
      ADD COLUMN IF NOT EXISTS kind pin_kind NOT NULL DEFAULT 'obstacle';
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS obstacles_lat_lng_idx
      ON obstacles (lat, lng);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS obstacles_user_id_idx
      ON obstacles (user_id);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS obstacles_kind_lat_lng_idx
      ON obstacles (kind, lat, lng);
  `;

  await sql`
    DO $$ BEGIN
      CREATE TYPE obstacle_vote_value AS ENUM ('up', 'down');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS obstacle_votes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      obstacle_id uuid NOT NULL REFERENCES obstacles(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value obstacle_vote_value NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS obstacle_votes_obstacle_id_idx
      ON obstacle_votes (obstacle_id);
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS obstacle_votes_obstacle_user_uidx
      ON obstacle_votes (obstacle_id, user_id);
  `;
}

const SCHEMA_TIMEOUT_MS = 25_000;

/**
 * Ensure tables/extensions exist. Runs at most once per process (concurrent
 * callers share the same promise) so map traffic cannot stampede DDL.
 */
export async function ensurePostgisSchema(): Promise<void> {
  if (global.__caniflySchemaReady) return;

  if (!global.__caniflySchemaPromise) {
    global.__caniflySchemaPromise = (async () => {
      await Promise.race([
        runPostgisSchemaMigrations(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("PostGIS schema bootstrap timed out")),
            SCHEMA_TIMEOUT_MS,
          );
        }),
      ]);
      global.__caniflySchemaReady = true;
    })().catch((err) => {
      global.__caniflySchemaPromise = undefined;
      global.__caniflySchemaReady = false;
      throw err;
    });
  }

  await global.__caniflySchemaPromise;
}
