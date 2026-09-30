// URLs of the script view and its print layout. `?cue=` is the same parameter the cue list
// and tech mode use, so "Show in script" / "Show in list" round-trip it.

/** `/shows/<id>/script?cue=<cueId>`: the script scrolled to the cue's marker (flashed). */
export function scriptUrl(showId: string, cueId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/script`;
  return cueId ? `${base}?cue=${encodeURIComponent(cueId)}` : base;
}

/** The calling-script print: `?version=` (default current) and `?filter=` (the filter bar). */
export function scriptPrintUrl(
  showId: string,
  opts: { versionId?: string | null; filter?: string } = {},
): string {
  const p = new URLSearchParams();
  if (opts.versionId) p.set("version", opts.versionId);
  if (opts.filter) p.set("filter", opts.filter);
  const q = p.toString();
  return `/shows/${encodeURIComponent(showId)}/script/print${q ? `?${q}` : ""}`;
}
