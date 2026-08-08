/**
 * Decode DJI FlightRecord .txt via pydjirecord CLI (optional DJI_API_KEY for tracks).
 * pydjirecord JSON uses camelCase detail fields (totalTime, aircraftName, …).
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, "../../..");

export type DecodedDjiFlight = {
  contentHash: string;
  sourceFileName: string;
  version: number | null;
  startedAt: Date;
  durationS: number;
  distanceM: number;
  maxHeightM: number | null;
  maxHSpeedMps: number | null;
  aircraftName: string | null;
  aircraftSn: string | null;
  appPlatform: string | null;
  appVersion: string | null;
  startLat: number | null;
  startLng: number | null;
  trackCoordinates: number[][] | null;
  rawDetails: Record<string, unknown>;
  trackDecrypted: boolean;
};

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveDjirecordBin(): Promise<string> {
  const candidates = [
    process.env.DJI_DECODE_BIN?.trim(),
    "/opt/dji-decode/bin/djirecord",
    join(API_ROOT, ".venv-dji", "bin", "djirecord"),
    join(homedir(), ".cache", "canifly-dji-decode", "bin", "djirecord"),
    "/tmp/dji-decode-venv/bin/djirecord",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return "djirecord";
}

/** Python next to djirecord (venv), else plain python3. */
async function resolveDecodePython(djirecordBin: string): Promise<string> {
  const dir = dirname(djirecordBin);
  for (const name of ["python", "python3"]) {
    const candidate = join(dir, name);
    if (await pathExists(candidate)) return candidate;
  }
  return "python3";
}

async function resolveDecodeScript(): Promise<string | null> {
  const candidates = [
    process.env.DJI_DECODE_SCRIPT?.trim(),
    "/opt/dji-decode/bin/canifly-dji-decode.py",
    join(API_ROOT, "scripts/dji_decode_flight.py"),
    // Older deploys may only have the details helper.
    process.env.DJI_DETAILS_SCRIPT?.trim(),
    "/opt/dji-decode/bin/canifly-dji-details.py",
    join(API_ROOT, "scripts/dji_details_json.py"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

function decodeEnv(includeApiKey: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // pydjirecord CLI reads DJI_API_KEY from the environment. Our helper takes
  // --api-key explicitly; strip env so stock fallbacks stay details-safe.
  if (!includeApiKey) {
    delete env.DJI_API_KEY;
  }
  return env;
}

async function runExec(
  bin: string,
  args: string[],
  opts?: { includeApiKey?: boolean },
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
      env: decodeEnv(Boolean(opts?.includeApiKey)),
    });
    if (!stdout.trim()) {
      return { ok: false, error: stderr.trim() || "empty decoder output" };
    }
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const raw = (e.stderr || e.message || String(err)).trim();
    const short =
      raw
        .split("\n")
        .map((l) => l.trim())
        .find(
          (l) =>
            l.startsWith("dji_decode_flight failed:") ||
            l.startsWith("dji_details_json failed:"),
        ) ||
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("File ") && !l.startsWith("Traceback"))
        .at(-1) ||
      raw;
    return { ok: false, error: short.slice(0, 400) };
  }
}

async function runDjirecord(
  bin: string,
  filePath: string,
  args: string[],
  opts?: { includeApiKey?: boolean },
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return runExec(bin, [filePath, ...args], opts);
}

type DecoderPayload = {
  version?: number;
  details?: Record<string, unknown>;
  frames?: unknown;
  trackCoordinates?: number[][] | null;
  trackSource?: string | null;
  trackError?: string | null;
};

/** Unified helper: details + optional GPS track (OSD fallback if frames crash). */
async function runFlightDecode(
  djirecordBin: string,
  filePath: string,
  apiKey: string,
): Promise<{ ok: true; payload: DecoderPayload } | { ok: false; error: string }> {
  const script = await resolveDecodeScript();
  if (!script) {
    const detailsRes = await runDjirecord(djirecordBin, filePath, ["--json"], {
      includeApiKey: false,
    });
    if (!detailsRes.ok) return detailsRes;
    try {
      return {
        ok: true,
        payload: JSON.parse(detailsRes.stdout) as DecoderPayload,
      };
    } catch {
      return { ok: false, error: "invalid decoder JSON" };
    }
  }

  const py = await resolveDecodePython(djirecordBin);
  const args = [script, filePath];
  // Full decoder accepts --api-key; legacy details script ignores unknown args
  // only if it uses argparse — our details script doesn't. Detect by name.
  const isFull =
    script.includes("dji_decode_flight") || script.includes("canifly-dji-decode");
  if (isFull && apiKey) {
    args.push("--api-key", apiKey);
  }

  const res = await runExec(py, args, { includeApiKey: false });
  if (!res.ok) return res;
  try {
    return { ok: true, payload: JSON.parse(res.stdout) as DecoderPayload };
  } catch {
    return { ok: false, error: "invalid decoder JSON" };
  }
}

function finiteCoord(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) < 1e-6 && Math.abs(ln) < 1e-6) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return { lat: la, lng: ln };
}

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Haversine path length in meters for [[lng,lat], …]. */
export function trackDistanceM(coords: number[][] | null | undefined): number {
  if (!coords || coords.length < 2) return 0;
  const R = 6371000;
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1]!;
    const [lng2, lat2] = coords[i]!;
    if (
      ![lng1, lat1, lng2, lat2].every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      continue;
    }
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    sum += 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return sum;
}

function trackFromGeoJson(raw: unknown): number[][] | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as GeoJSON.FeatureCollection | GeoJSON.Feature | GeoJSON.Geometry;
  let geom: GeoJSON.Geometry | null = null;
  if (g.type === "FeatureCollection") {
    const f = g.features?.find(
      (x) =>
        x.geometry?.type === "LineString" ||
        x.geometry?.type === "MultiLineString",
    );
    geom = f?.geometry ?? null;
  } else if (g.type === "Feature") {
    geom = g.geometry;
  } else if ("coordinates" in g) {
    geom = g as GeoJSON.Geometry;
  }
  if (!geom) return null;

  const toPoint = (c: number[]): number[] | null => {
    if (
      !Array.isArray(c) ||
      typeof c[0] !== "number" ||
      typeof c[1] !== "number" ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1])
    ) {
      return null;
    }
    const alt = c[2];
    if (typeof alt === "number" && Number.isFinite(alt)) {
      return [c[0], c[1], alt];
    }
    return [c[0], c[1]];
  };

  if (geom.type === "LineString") {
    const coords = geom.coordinates
      .map((c) => toPoint(c as number[]))
      .filter((c): c is number[] => Boolean(c));
    return coords.length >= 2 ? coords : null;
  }
  if (geom.type === "MultiLineString") {
    const longest = [...geom.coordinates].sort((a, b) => b.length - a.length)[0];
    const coords = (longest ?? [])
      .map((c) => toPoint(c as number[]))
      .filter((c): c is number[] => Boolean(c));
    return coords.length >= 2 ? coords : null;
  }
  return null;
}

/** Parse FlightRecord_YYYY-MM-DD_[HH-MM-SS].txt as a local-wall-clock instant (no TZ). */
export function startedAtFromFileName(name: string): Date | null {
  const m = name.match(
    /FlightRecord_(\d{4})-(\d{2})-(\d{2})_\[(\d{2})-(\d{2})-(\d{2})\]/i,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const dt = new Date(iso);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function pickDetails(raw: Record<string, unknown>): {
  startedAt: Date | null;
  durationS: number;
  distanceM: number;
  maxHeightM: number | null;
  maxHSpeedMps: number | null;
  aircraftName: string | null;
  aircraftSn: string | null;
  appPlatform: string | null;
  appVersion: string | null;
  startLat: number | null;
  startLng: number | null;
} {
  const start = finiteCoord(raw.latitude, raw.longitude);
  const startedRaw = str(raw.startTime, raw.start_time, raw.dateTime);
  const startedAt = startedRaw ? new Date(startedRaw) : null;

  return {
    startedAt:
      startedAt && Number.isFinite(startedAt.getTime()) ? startedAt : null,
    durationS:
      num(raw.totalTime, raw.total_time, raw.flyTime, raw.fly_time) ?? 0,
    distanceM:
      num(raw.totalDistance, raw.total_distance, raw.cumulativeDistance) ?? 0,
    maxHeightM: num(raw.maxHeight, raw.max_height, raw.heightMax),
    maxHSpeedMps: num(
      raw.maxHorizontalSpeed,
      raw.max_horizontal_speed,
      raw.hSpeedMax,
    ),
    aircraftName: str(raw.aircraftName, raw.aircraft_name, raw.productName),
    aircraftSn: str(raw.aircraftSn, raw.aircraft_sn),
    appPlatform: str(raw.appPlatform, raw.app_platform),
    appVersion: str(raw.appVersion, raw.app_version),
    startLat: start?.lat ?? null,
    startLng: start?.lng ?? null,
  };
}

function lastFrameOsd(
  frames: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const last = frames[frames.length - 1];
  if (!last || typeof last !== "object") return null;
  const osd = (last as { osd?: unknown }).osd;
  if (!osd || typeof osd !== "object") return null;
  return osd as Record<string, unknown>;
}

function firstFrameOsd(
  frames: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const first = frames[0];
  if (!first || typeof first !== "object") return null;
  const osd = (first as { osd?: unknown }).osd;
  if (!osd || typeof osd !== "object") return null;
  return osd as Record<string, unknown>;
}

export async function decodeDjiFlightRecord(
  fileBytes: Buffer,
  sourceFileName: string,
): Promise<DecodedDjiFlight> {
  const contentHash = sha256(fileBytes);
  const bin = await resolveDjirecordBin();
  const apiKey = process.env.DJI_API_KEY?.trim() || "";

  // Prefer /tmp — app dir can be non-writable on some hosts.
  const tmpDir = join("/tmp", "canifly-dji-uploads");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `${contentHash}.txt`);
  await writeFile(tmpPath, fileBytes);

  const decoded = await runFlightDecode(bin, tmpPath, apiKey);
  if (!decoded.ok) {
    throw new Error(
      `DJI decode failed (${decoded.error}). Install pydjirecord (Python 3.11+) or set DJI_DECODE_BIN.`,
    );
  }

  const payload = decoded.payload;
  const details = { ...(payload.details ?? {}) };
  const fromDetails = pickDetails(details);
  const lastOsd = lastFrameOsd(payload.frames);
  const firstOsd = firstFrameOsd(payload.frames);
  const fromLast = lastOsd ? pickDetails(lastOsd) : null;
  const fromFirst = firstOsd ? pickDetails(firstOsd) : null;

  let trackCoordinates: number[][] | null = null;
  let trackDecrypted = false;

  if (
    Array.isArray(payload.trackCoordinates) &&
    payload.trackCoordinates.length >= 2
  ) {
    trackCoordinates = payload.trackCoordinates.filter(
      (c) =>
        Array.isArray(c) &&
        typeof c[0] === "number" &&
        typeof c[1] === "number" &&
        Number.isFinite(c[0]) &&
        Number.isFinite(c[1]),
    );
    if (trackCoordinates.length < 2) trackCoordinates = null;
    trackDecrypted = Boolean(trackCoordinates);
  } else if (apiKey) {
    // Legacy path if only the details script is deployed.
    const geoRes = await runDjirecord(
      bin,
      tmpPath,
      ["--geojson", "--api-key", apiKey],
      { includeApiKey: true },
    );
    if (geoRes.ok) {
      try {
        trackCoordinates = trackFromGeoJson(JSON.parse(geoRes.stdout));
        trackDecrypted = Boolean(trackCoordinates);
      } catch {
        // metadata-only
      }
    } else {
      console.warn(
        `[dji] geojson decode skipped for ${sourceFileName}: ${geoRes.error.slice(0, 200)}`,
      );
    }
  }

  if (payload.trackError) {
    console.warn(
      `[dji] track for ${sourceFileName}: ${payload.trackError} (source=${payload.trackSource ?? "none"})`,
    );
  }

  // Prefer details → last OSD → haversine(track)
  let durationS =
    fromDetails.durationS || fromLast?.durationS || 0;
  let distanceM =
    fromDetails.distanceM ||
    fromLast?.distanceM ||
    trackDistanceM(trackCoordinates);
  const maxHeightM =
    fromDetails.maxHeightM ?? fromLast?.maxHeightM ?? null;
  const maxHSpeedMps =
    fromDetails.maxHSpeedMps ?? fromLast?.maxHSpeedMps ?? null;
  const aircraftName =
    fromDetails.aircraftName ?? fromLast?.aircraftName ?? null;
  const aircraftSn =
    fromDetails.aircraftSn ?? fromLast?.aircraftSn ?? null;
  const appPlatform =
    fromDetails.appPlatform ?? fromLast?.appPlatform ?? null;
  const appVersion =
    fromDetails.appVersion ?? fromLast?.appVersion ?? null;

  let startLat =
    fromDetails.startLat ?? fromFirst?.startLat ?? null;
  let startLng =
    fromDetails.startLng ?? fromFirst?.startLng ?? null;
  if (
    (startLat == null || startLng == null) &&
    trackCoordinates &&
    trackCoordinates.length > 0
  ) {
    startLng = trackCoordinates[0]![0]!;
    startLat = trackCoordinates[0]![1]!;
  }

  if (distanceM <= 0) {
    distanceM = trackDistanceM(trackCoordinates);
  }

  const startedAt =
    fromDetails.startedAt ??
    startedAtFromFileName(sourceFileName) ??
    new Date();

  return {
    contentHash,
    sourceFileName,
    version: payload.version ?? null,
    startedAt,
    durationS,
    distanceM,
    maxHeightM,
    maxHSpeedMps,
    aircraftName,
    aircraftSn,
    appPlatform,
    appVersion,
    startLat,
    startLng,
    trackCoordinates,
    rawDetails: {
      ...details,
      _lastOsd: lastOsd ?? undefined,
      _trackSource: payload.trackSource ?? undefined,
      _trackError: payload.trackError ?? undefined,
    },
    trackDecrypted,
  };
}
