// Content naming convention `SSS-NNN-NAME` (data-model.md §Content): scene number, running
// number within the scene, then a name. Used when content is created from a picker.

const PREFIX = /^(\d{3})-(\d{3})-/;

/** "105" → "105", "99" → "099"; null when the scene number isn't 1–3 digits. */
export function scenePrefix(sceneNumber: string | null | undefined): string | null {
  const n = sceneNumber?.trim() ?? "";
  return /^\d{1,3}$/.test(n) ? n.padStart(3, "0") : null;
}

/**
 * The name for new content typed as `typed` in a scene. Kept as typed when it already
 * starts with `SSS-NNN-` or there's no usable scene number; otherwise prefixed with the
 * scene number and the next free NNN in that scene (max existing + 1).
 */
export function prefixedContentName(
  typed: string,
  sceneNumber: string | null | undefined,
  existingNames: Iterable<string | null>,
): string {
  const name = typed.trim();
  if (PREFIX.test(name)) return name;
  const sss = scenePrefix(sceneNumber);
  if (!sss) return name;
  let max = 0;
  for (const existing of existingNames) {
    const m = PREFIX.exec(existing?.trim() ?? "");
    if (m?.[1] === sss) max = Math.max(max, Number(m[2]));
  }
  return `${sss}-${String(max + 1).padStart(3, "0")}-${name}`;
}

/** The name without its `SSS-NNN-` prefix ("105-001-VAMP" → "VAMP"). */
export function contentBaseName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(PREFIX, "");
}
