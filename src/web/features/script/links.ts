// URLs of the script view and its print layout. `?cue=` is the same parameter the cue list
// and tech mode use, so "Show in script" / "Show in list" round-trip it.

/** `/shows/<id>/script?cue=<cueId>`: the script scrolled to the cue's marker (flashed). */
export function scriptUrl(showId: string, cueId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/script`;
  return cueId ? `${base}?cue=${encodeURIComponent(cueId)}` : base;
}

/**
 * The calling-script print: `?version=` (default current), `?filter=` (the filter bar) and
 * `?layout=pdf` (the original PDF's pages with the cue margin, instead of the text).
 */
export function scriptPrintUrl(
  showId: string,
  opts: { versionId?: string | null; filter?: string; layout?: "pdf" | null } = {},
): string {
  const p = new URLSearchParams();
  if (opts.versionId) p.set("version", opts.versionId);
  if (opts.filter) p.set("filter", opts.filter);
  if (opts.layout) p.set("layout", opts.layout);
  const q = p.toString();
  return `/shows/${encodeURIComponent(showId)}/script/print${q ? `?${q}` : ""}`;
}
