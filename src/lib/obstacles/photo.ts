import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

async function saveUnder(
  dirName: "obstacles" | "avatars",
  file: File,
): Promise<{ url: string } | { error: string }> {
  if (!ALLOWED.has(file.type)) {
    return { error: "Photo must be JPEG, PNG, or WebP" };
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return { error: "Photo must be under 5 MB" };
  }

  const uploadDir = path.join(process.cwd(), "uploads", dirName);
  await mkdir(uploadDir, { recursive: true });
  const ext = EXT[file.type] ?? "jpg";
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(uploadDir, filename), Buffer.from(await file.arrayBuffer()));
  return { url: `/uploads/${dirName}/${filename}` };
}

async function deleteUnder(
  dirName: "obstacles" | "avatars",
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
