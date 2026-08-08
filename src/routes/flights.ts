import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { inflateRawSync, inflateSync } from "node:zlib";
import { getSessionUser, isSessionUser, requireUser } from "../lib/auth/session";
import { ensurePostgisSchema, getDb, isDatabaseAvailable } from "../lib/db/client";
import {
  deleteFlightByOwner,
  findFlightByUserHash,
  flightSummaryJson,
  getFlightById,
  insertFlight,
  listFlightsByUser,
  queryFlightsInBbox,
} from "../lib/db/flight-queries";
import { flights } from "../lib/db/schema";
import { decodeDjiFlightRecord } from "../lib/flights/decode-dji";
import { syncRankInbox } from "../lib/db/rank-inbox";

export const flightsRoutes = new Hono();

const idSchema = z.string().uuid();
const bboxSchema = z.object({
  west: z.coerce.number(),
  south: z.coerce.number(),
  east: z.coerce.number(),
  north: z.coerce.number(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
  mine: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional(),
});

function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/** Minimal ZIP extract of FlightRecord*.txt (store/deflate). */
function unzipFlightRecordFiles(
  buf: Buffer,
): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const flags = buf.readUInt16LE(offset + 6);
    let compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    // Prefer central-directory sizes when local are zero (data descriptor).
    if ((flags & 0x8) !== 0 && compSize === 0) {
      break; // fall back: ask user to upload loose .txt for descriptor zips
    }
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) break;
    const payload = buf.subarray(dataStart, dataEnd);
    const base = name.split("/").pop() ?? name;
    if (
      /FlightRecord_.*\.txt$/i.test(base) &&
      !name.includes("__MACOSX")
    ) {
      let data: Buffer;
      if (method === 0) data = Buffer.from(payload);
      else if (method === 8) data = inflateRawSync(payload);
      else throw new Error(`unsupported zip method ${method} for ${base}`);
      out.push({ name: base, data });
    }
    offset = dataEnd;
  }
  return out;
}

/** Prefer central directory for data-descriptor ZIPs (iOS share zips). */
function unzipFlightRecordsViaCentralDir(
  buf: Buffer,
): { name: string; data: Buffer }[] {
  let eocd = -1;
  const min = Math.max(0, buf.length - 65_536 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return unzipFlightRecordFiles(buf);

  let offset = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  while (offset + 46 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf
      .subarray(offset + 46, offset + 46 + nameLen)
      .toString("utf8");
    const base = name.split("/").pop() ?? name;
    if (/FlightRecord_.*\.txt$/i.test(base) && !name.includes("__MACOSX")) {
      const lhNameLen = buf.readUInt16LE(localOff + 26);
      const lhExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const payload = buf.subarray(dataStart, dataStart + compSize);
      let data: Buffer;
      if (method === 0) data = Buffer.from(payload);
      else if (method === 8) {
        try {
          data = inflateRawSync(payload);
        } catch {
          data = inflateSync(payload);
        }
      } else {
        offset += 46 + nameLen + extraLen + commentLen;
        continue;
      }
      out.push({ name: base, data });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out.length > 0 ? out : unzipFlightRecordFiles(buf);
}

flightsRoutes.get("/bbox", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ type: "FeatureCollection", features: [] });
    }
    await ensurePostgisSchema();
    const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const parsed = bboxSchema.safeParse(params);
    if (!parsed.success) {
      return c.json({ error: "Invalid bbox" }, 400);
    }
    const { west, south, east, north, limit, mine } = parsed.data;
    const session = await getSessionUser(c);
    const onlyMine = mine === "1" || mine === "true";
    if (onlyMine && !session) {
      return c.json({ type: "FeatureCollection", features: [] });
    }
    const collection = await queryFlightsInBbox(
      west,
      south,
      east,
      north,
      limit,
      onlyMine ? session?.id : undefined,
    );
    return c.json(collection);
  } catch (err) {
    console.error("[flights/bbox]", err);
    return c.json({ error: "Failed to load flights" }, 500);
  }
});

flightsRoutes.get("/mine", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }
    await ensurePostgisSchema();
    const rows = await listFlightsByUser(auth.id, 200);
    return c.json({
      flights: rows.map(flightSummaryJson),
      djiApiKeyConfigured: Boolean(process.env.DJI_API_KEY?.trim()),
    });
  } catch (err) {
    console.error("[flights/mine]", err);
    return c.json({ error: "Failed to list flights" }, 500);
  }
});

flightsRoutes.get("/:id", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }
    await ensurePostgisSchema();
    const parsed = idSchema.safeParse(c.req.param("id"));
    if (!parsed.success) return c.json({ error: "Invalid id" }, 400);
    const row = await getFlightById(parsed.data);
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({
      flight: {
        ...flightSummaryJson(row),
        trackCoordinates: row.trackCoordinates,
        aircraftSn: row.aircraftSn,
        appPlatform: row.appPlatform,
        appVersion: row.appVersion,
      },
    });
  } catch (err) {
    console.error("[flights/:id]", err);
    return c.json({ error: "Failed to load flight" }, 500);
  }
});

flightsRoutes.delete("/:id", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;
    await ensurePostgisSchema();
    const parsed = idSchema.safeParse(c.req.param("id"));
    if (!parsed.success) return c.json({ error: "Invalid id" }, 400);
    const ok = await deleteFlightByOwner(parsed.data, auth.id);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[flights/DELETE]", err);
    return c.json({ error: "Failed to delete" }, 500);
  }
});

flightsRoutes.post("/upload", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }
    await ensurePostgisSchema();

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "multipart/form-data required" }, 400);
    }

    const form = await c.req.formData();
    const files: File[] = [];
    for (const [key, value] of form.entries()) {
      if (
        (key === "file" || key === "files" || key.startsWith("file")) &&
        value instanceof File
      ) {
        files.push(value);
      }
    }
    if (files.length === 0) {
      return c.json({ error: "No files uploaded" }, 400);
    }

    const records: { name: string; data: Buffer }[] = [];
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      const name = file.name || "upload.bin";
      if (isZip(buf) || /\.zip$/i.test(name)) {
        const extracted = unzipFlightRecordsViaCentralDir(buf);
        if (extracted.length === 0) {
          return c.json(
            {
              error:
                "ZIP had no FlightRecord_*.txt files (or used unsupported compression). Upload the .txt files directly.",
            },
            400,
          );
        }
        records.push(...extracted);
      } else if (/FlightRecord_.*\.txt$/i.test(name) || /\.txt$/i.test(name)) {
        records.push({ name, data: buf });
      }
    }

    if (records.length === 0) {
      return c.json(
        { error: "Upload FlightRecord_*.txt files or a FlightRecords zip" },
        400,
      );
    }

    const imported: ReturnType<typeof flightSummaryJson>[] = [];
    const skipped: { file: string; reason: string }[] = [];
    const errors: { file: string; error: string }[] = [];

    for (const rec of records) {
      try {
        const decoded = await decodeDjiFlightRecord(rec.data, rec.name);
        const existing = await findFlightByUserHash(
          auth.id,
          decoded.contentHash,
        );
        if (existing) {
          // Refresh metadata + tracks (fixes camelCase decode miss / missing key).
          const { db } = getDb();
          const [updated] = await db
            .update(flights)
            .set({
              trackCoordinates:
                decoded.trackCoordinates ?? existing.trackCoordinates,
              startLat: decoded.startLat ?? existing.startLat,
              startLng: decoded.startLng ?? existing.startLng,
              distanceM:
                decoded.distanceM > 0 ? decoded.distanceM : existing.distanceM,
              durationS:
                decoded.durationS > 0 ? decoded.durationS : existing.durationS,
              maxHeightM: decoded.maxHeightM ?? existing.maxHeightM,
              maxHSpeedMps: decoded.maxHSpeedMps ?? existing.maxHSpeedMps,
              aircraftName: decoded.aircraftName ?? existing.aircraftName,
              aircraftSn: decoded.aircraftSn ?? existing.aircraftSn,
              appPlatform: decoded.appPlatform ?? existing.appPlatform,
              appVersion: decoded.appVersion ?? existing.appVersion,
              startedAt: decoded.startedAt,
              rawDetails: decoded.rawDetails ?? existing.rawDetails,
              sourceFileName: decoded.sourceFileName || existing.sourceFileName,
            })
            .where(eq(flights.id, existing.id))
            .returning();
          if (updated) {
            imported.push(flightSummaryJson(updated));
            continue;
          }
          skipped.push({ file: rec.name, reason: "already synced" });
          imported.push(flightSummaryJson(existing));
          continue;
        }
        const row = await insertFlight({
          userId: auth.id,
          source: "dji_fly",
          sourceFileName: decoded.sourceFileName,
          contentHash: decoded.contentHash,
          startedAt: decoded.startedAt,
          durationS: decoded.durationS,
          distanceM: decoded.distanceM,
          maxHeightM: decoded.maxHeightM,
          maxHSpeedMps: decoded.maxHSpeedMps,
          aircraftName: decoded.aircraftName,
          aircraftSn: decoded.aircraftSn,
          appPlatform: decoded.appPlatform,
          appVersion: decoded.appVersion,
          startLat: decoded.startLat,
          startLng: decoded.startLng,
          trackCoordinates: decoded.trackCoordinates,
          rawDetails: decoded.rawDetails,
        });
        imported.push(flightSummaryJson(row));
      } catch (err) {
        errors.push({
          file: rec.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (imported.length > 0) {
      try {
        await syncRankInbox(auth.id);
      } catch (err) {
        console.error("[flights/upload] rank inbox sync", err);
      }
    }

    return c.json({
      imported,
      skipped,
      errors,
      djiApiKeyConfigured: Boolean(process.env.DJI_API_KEY?.trim()),
      note: process.env.DJI_API_KEY?.trim()
        ? undefined
        : "Set DJI_API_KEY on the API for full track decryption (v13+). Metadata still syncs.",
    });
  } catch (err) {
    console.error("[flights/upload]", err);
    return c.json({ error: "Upload failed" }, 500);
  }
});
