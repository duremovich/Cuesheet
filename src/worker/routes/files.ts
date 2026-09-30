// The per-show storage counter in D1 (`shows.storage_bytes`) used by the attachment routes.
// Bytes of deleted files are given back when the ShowDO's alarm purges them (a day later).
import { SHOW_STORAGE_LIMIT_BYTES } from "../../shared/attachments";

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
