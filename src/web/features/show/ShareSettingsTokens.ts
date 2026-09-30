// Share links are shown once (the server keeps only a hash of the token), so this browser
// remembers the links its owner created, per show (localStorage
// `cuesheet.shareLinks.<showId>`: link id → `/s/<token>`), to copy them again later and to
// put them in "Distribute notes" emails. Revoking forgets it.

const key = (showId: string) => `cuesheet.shareLinks.${showId}`;

export function rememberedLinks(showId: string): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key(showId)) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (e): e is [string, string] => typeof e[1] === "string" && e[1].startsWith("/s/"),
      ),
    );
  } catch {
    return {};
  }
}

export function rememberLink(showId: string, linkId: string, path: string): void {
  try {
    localStorage.setItem(
      key(showId),
      JSON.stringify({ ...rememberedLinks(showId), [linkId]: path }),
    );
  } catch {
    // storage full or blocked: the link just can't be copied again later
  }
}

export function forgetLink(showId: string, linkId: string): void {
  try {
    const all = rememberedLinks(showId);
    delete all[linkId];
    localStorage.setItem(key(showId), JSON.stringify(all));
  } catch {
    // ignore
  }
}

/** The absolute URL of a share path on this site. */
export function shareUrl(path: string, loc: Location = window.location): string {
  return `${loc.origin}${path}`;
}
