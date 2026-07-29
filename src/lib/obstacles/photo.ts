import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import sharp from "sharp";

/** Accept larger phone originals; we recompress before writing. */
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

const MAX_EDGE = {
  obstacles: 1600,
  avatars: 512,
} as const;

const JPEG_QUALITY = {
  obstacles: 82,
  avatars: 85,
} as const;

type DirName = "obstacles" | "avatars";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "canifly-uploads";

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "").trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

async function compressImage(
  dirName: DirName,
  file: File,
): Promise<{ buffer: Buffer } | { error: string }> {
  if (!ALLOWED.has(file.type)) {
    return { error: "Photo must be JPEG, PNG, or WebP" };
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return { error: "Photo must be under 12 MB" };
  }

  const input = Buffer.from(await file.arrayBuffer());
  const edge = MAX_EDGE[dirName];
  const quality = JPEG_QUALITY[dirName];

  try {
    const out = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({
        width: edge,
        height: edge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return { buffer: out };
  } catch {
    return { error: "Could not process image" };
  }
}

function storageHeaders(key: string, contentType?: string): HeadersInit {
  const headers: Record<string, string> = {
    apikey: key,
  };
  // Legacy service_role is a JWT and must be sent as Bearer.
  // New sb_secret_ keys are NOT JWTs — Bearer causes "Invalid JWT".
  if (key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${key}`;
  } else {
    // Allowed when Authorization exactly matches apikey (new key model).
    headers.Authorization = key;
  }
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function ensurePublicBucket(cfg: { url: string; key: string }) {
  const res = await fetch(`${cfg.url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      ...storageHeaders(cfg.key, "application/json"),
    },
    body: JSON.stringify({
      name: BUCKET,
      public: true,
      file_size_limit: 12 * 1024 * 1024,
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp"],
    }),
  });
  // 200 created, 409 already exists — both fine
  if (!res.ok && res.status !== 409) {
    const body = await res.text().catch(() => "");
    console.warn("[storage] ensure bucket", res.status, body.slice(0, 200));
  }
}

async function saveToSupabase(
  dirName: DirName,
  buffer: Buffer,
): Promise<{ url: string } | { error: string }> {
  const cfg = supabaseConfig();
  if (!cfg) return { error: "Storage not configured" };

  await ensurePublicBucket(cfg);

  const filename = `${randomUUID()}.jpg`;
  const objectPath = `${dirName}/${filename}`;
  const uploadUrl = `${cfg.url}/storage/v1/object/${BUCKET}/${objectPath}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...storageHeaders(cfg.key, "image/jpeg"),
      "x-upsert": "false",
    },
    body: buffer,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[storage] upload failed", res.status, body.slice(0, 300));
    return {
      error:
        res.status === 404 || body.includes("Bucket not found")
          ? "Storage bucket missing — create public bucket canifly-uploads in Supabase"
          : "Could not upload image",
    };
  }

  const publicUrl = `${cfg.url}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  return { url: publicUrl };
}

async function deleteFromSupabase(photoUrl: string) {
  const cfg = supabaseConfig();
  if (!cfg) return;

  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = photoUrl.indexOf(marker);
  if (idx === -1) return;
  const objectPath = photoUrl.slice(idx + marker.length);
  if (!objectPath || objectPath.includes("..")) return;

  const res = await fetch(
    `${cfg.url}/storage/v1/object/${BUCKET}/${objectPath}`,
    {
      method: "DELETE",
      headers: storageHeaders(cfg.key),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[storage] delete failed", res.status, body.slice(0, 200));
  }
}

async function saveLocal(
  dirName: DirName,
  buffer: Buffer,
): Promise<{ url: string }> {
  const uploadDir = path.join(process.cwd(), "uploads", dirName);
  await mkdir(uploadDir, { recursive: true });
  const filename = `${randomUUID()}.jpg`;
  await writeFile(path.join(uploadDir, filename), buffer);
  return { url: `/uploads/${dirName}/${filename}` };
}

async function deleteLocal(dirName: DirName, photoUrl: string) {
  const prefix = `/uploads/${dirName}/`;
  if (!photoUrl.startsWith(prefix)) return;
  const name = path.basename(photoUrl);
  if (!name || name.includes("..")) return;
  try {
    await unlink(path.join(process.cwd(), "uploads", dirName, name));
  } catch {
    /* ignore */
  }
}

async function saveUnder(
  dirName: DirName,
  file: File,
): Promise<{ url: string } | { error: string }> {
  const compressed = await compressImage(dirName, file);
  if ("error" in compressed) return compressed;

  if (supabaseConfig()) {
    return saveToSupabase(dirName, compressed.buffer);
  }
  return saveLocal(dirName, compressed.buffer);
}

async function deleteUnder(
  dirName: DirName,
  photoUrl: string | null | undefined,
) {
  if (!photoUrl) return;
  if (photoUrl.includes("/storage/v1/object/public/")) {
    await deleteFromSupabase(photoUrl);
    return;
  }
  await deleteLocal(dirName, photoUrl);
}

export async function saveObstaclePhoto(file: File) {
  return saveUnder("obstacles", file);
}

export async function deleteObstaclePhoto(photoUrl: string | null | undefined) {
  return deleteUnder("obstacles", photoUrl);
}

export async function saveAvatarPhoto(file: File) {
  return saveUnder("avatars", file);
}

export async function deleteAvatarPhoto(photoUrl: string | null | undefined) {
  return deleteUnder("avatars", photoUrl);
}
