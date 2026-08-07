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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

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
