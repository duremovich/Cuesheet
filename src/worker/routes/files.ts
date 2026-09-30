// R2 bookkeeping shared by the attachment routes and /mutate: the per-show storage counter in
// D1 (`shows.storage_bytes`) and deleting files whose attachment rows are gone.
import { SHOW_STORAGE_LIMIT_BYTES, thumbnailKey } from "../../shared/attachments";
import type { FreedFile } from "../do/ops-engine";

/**
 * Add `bytes` to the show's storage if it stays within the limit. Returns false (nothing
 * changed) when it wouldn't: the caller answers 413. Atomic, so concurrent uploads can't
 * overshoot together.
 */
export async function reserveStorage(env: Env, showId: string, bytes: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE shows SET storage_bytes = storage_bytes + ?1 WHERE id = ?2 AND storage_bytes + ?1 <= ?3 RETURNING storage_bytes",
  )
    .bind(bytes, showId, SHOW_STORAGE_LIMIT_BYTES)
    .first();
  return row !== null;
}

export async function releaseStorage(env: Env, showId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await env.DB.prepare("UPDATE shows SET storage_bytes = max(0, storage_bytes - ?1) WHERE id = ?2")
    .bind(bytes, showId)
    .run();
}

export async function storageUsed(env: Env, showId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT storage_bytes AS n FROM shows WHERE id = ?1")
    .bind(showId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * After a batch deleted attachment rows: delete their files and thumbnails from R2 and give
 * the bytes back. Best effort (runs in `waitUntil`); a failure leaves an orphaned object,
 * never a row pointing at nothing.
 */
export async function releaseFiles(env: Env, showId: string, freed: FreedFile[]): Promise<void> {
  if (freed.length === 0) return;
  try {
    const keys = freed.flatMap((f) => [f.r2_key, thumbnailKey(showId, f.id)]);
    for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
  } catch (e) {
    console.error("R2 delete failed", e);
  }
  await releaseStorage(
    env,
    showId,
    freed.reduce((n, f) => n + f.size, 0),
  );
}
