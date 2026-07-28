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

async function saveUnder(
  dirName: DirName,
  file: File,
): Promise<{ url: string } | { error: string }> {
  if (!ALLOWED.has(file.type)) {
    return { error: "Photo must be JPEG, PNG, or WebP" };
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return { error: "Photo must be under 12 MB" };
  }

  const uploadDir = path.join(process.cwd(), "uploads", dirName);
  await mkdir(uploadDir, { recursive: true });
  const filename = `${randomUUID()}.jpg`;
  const abs = path.join(uploadDir, filename);
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
    await writeFile(abs, out);
  } catch {
    return { error: "Could not process image" };
  }

  return { url: `/uploads/${dirName}/${filename}` };
}

async function deleteUnder(
  dirName: DirName,
  photoUrl: string | null | undefined,
) {
  const prefix = `/uploads/${dirName}/`;
  if (!photoUrl?.startsWith(prefix)) return;
  const name = path.basename(photoUrl);
  if (!name || name.includes("..")) return;
  try {
    await unlink(path.join(process.cwd(), "uploads", dirName, name));
  } catch {
    /* ignore */
  }
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
