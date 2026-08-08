import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UasZoneFeature } from "@canifly/middleware";

export const zoneSourceEnum = pgEnum("zone_source", [
  "aero",
  "urbano",
  "infra",
  "servais",
  "fixture",
  "pansa",
  "anscr",
  "dipul",
]);

export const pinKindEnum = pgEnum("pin_kind", ["obstacle", "fly_spot"]);

export const obstacleTypeEnum = pgEnum("obstacle_type", [
  "construction",
  "crane",
  "electric_line",
  "air_sports",
  "park",
  "rooftop",
  "field",
  "beach",
  "other",
]);

export const obstacleVoteValueEnum = pgEnum("obstacle_vote_value", [
  "up",
  "down",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  googleId: text("google_id"),
  name: text("name").notNull().default(""),
  operatorNumber: text("operator_number"),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  locale: text("locale").notNull().default("es"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  emailVerifyToken: text("email_verify_token"),
  emailVerifyExpires: timestamp("email_verify_expires", {
    withTimezone: true,
  }),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpires: timestamp("password_reset_expires", {
    withTimezone: true,
  }),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  marketingOptInAt: timestamp("marketing_opt_in_at", { withTimezone: true }),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  /** Last aviation rank the user was notified about (null = not baselined yet). */
  lastNotifiedRankId: text("last_notified_rank_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Server inbox — e.g. rank-up congratulations. */
export const userMessages = pgTable(
  "user_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("rank_up"),
    rankId: text("rank_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("user_messages_user_id_idx").on(table.userId),
    uniqueIndex("user_messages_user_kind_rank_uidx").on(
      table.userId,
      table.kind,
      table.rankId,
    ),
  ],
);

export type UserMessageRow = typeof userMessages.$inferSelect;
export type NewUserMessage = typeof userMessages.$inferInsert;

export const obstacles = pgTable(
  "obstacles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: pinKindEnum("kind").notNull().default("obstacle"),
    type: obstacleTypeEnum("type").notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    heightM: doublePrecision("height_m").notNull(),
    message: text("message"),
    photoUrl: text("photo_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("obstacles_lat_lng_idx").on(table.lat, table.lng),
    index("obstacles_user_id_idx").on(table.userId),
    index("obstacles_kind_lat_lng_idx").on(table.kind, table.lat, table.lng),
  ],
);

export type ObstacleRow = typeof obstacles.$inferSelect;
export type NewObstacle = typeof obstacles.$inferInsert;

export const obstacleVotes = pgTable(
  "obstacle_votes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    obstacleId: uuid("obstacle_id")
      .notNull()
      .references(() => obstacles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    value: obstacleVoteValueEnum("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("obstacle_votes_obstacle_id_idx").on(table.obstacleId),
    uniqueIndex("obstacle_votes_obstacle_user_uidx").on(
      table.obstacleId,
      table.userId,
    ),
  ],
);

export type ObstacleVoteRow = typeof obstacleVotes.$inferSelect;
export type NewObstacleVote = typeof obstacleVotes.$inferInsert;

/** Decoded DJI (or other) personal flight logs synced to a user account. */
export const flights = pgTable(
  "flights",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("dji_fly"),
    sourceFileName: text("source_file_name"),
    contentHash: text("content_hash").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationS: doublePrecision("duration_s").notNull().default(0),
    distanceM: doublePrecision("distance_m").notNull().default(0),
    maxHeightM: doublePrecision("max_height_m"),
    maxHSpeedMps: doublePrecision("max_h_speed_mps"),
    aircraftName: text("aircraft_name"),
    aircraftSn: text("aircraft_sn"),
    appPlatform: text("app_platform"),
    appVersion: text("app_version"),
    startLat: doublePrecision("start_lat"),
    startLng: doublePrecision("start_lng"),
    /** GeoJSON LineString coordinates [[lng,lat] | [lng,lat,alt], ...] or null if undecrypted */
    trackCoordinates: jsonb("track_coordinates").$type<number[][] | null>(),
    rawDetails: jsonb("raw_details").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("flights_user_id_idx").on(table.userId),
    index("flights_started_at_idx").on(table.startedAt),
    index("flights_start_lat_lng_idx").on(table.startLat, table.startLng),
    uniqueIndex("flights_user_content_hash_uidx").on(
      table.userId,
      table.contentHash,
    ),
  ],
);

export type FlightRow = typeof flights.$inferSelect;
export type NewFlight = typeof flights.$inferInsert;

/**
 * One spatial row per ED-318 horizontal geometry slice
 * (each slice has its own vertical limits).
 *
 * `geom` is stored as EWKT text via raw SQL inserts for PostGIS MultiPolygon(4326).
 * Drizzle maps it as text; spatial ops use sql`` templates.
 */
export const uasZoneSlices = pgTable(
  "uas_zone_slices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    zoneIdentifier: text("zone_identifier").notNull(),
    name: text("name").notNull(),
    source: zoneSourceEnum("source").notNull(),
    restriction: text("restriction").notNull(),
    reason: text("reason").array().notNull().default([]),
    zoneType: text("zone_type").notNull().default("COMMON"),
    lowerLimitM: doublePrecision("lower_limit_m").notNull().default(0),
    upperLimitM: doublePrecision("upper_limit_m").notNull().default(120),
    lowerRef: text("lower_ref").notNull().default("AGL"),
    upperRef: text("upper_ref").notNull().default("AGL"),
    properties: jsonb("properties").$type<UasZoneFeature>().notNull(),
    /** EWKT or WKT of MultiPolygon in EPSG:4326 */
    geomWkt: text("geom_wkt").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("uas_zone_slices_restriction_idx").on(table.restriction),
    index("uas_zone_slices_source_idx").on(table.source),
    index("uas_zone_slices_zone_identifier_idx").on(table.zoneIdentifier),
  ],
);

export type UasZoneSliceRow = typeof uasZoneSlices.$inferSelect;
export type NewUasZoneSlice = typeof uasZoneSlices.$inferInsert;
