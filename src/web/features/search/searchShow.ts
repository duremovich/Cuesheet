// Global search (R5b, ⌘K): cues by number / description / SM call, content by name, scenes
// by number + name, surfaces by name / channel, notes by body, people by name. Pure; the palette renders the result.

import { sceneTitle } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";
import { cueNumberKey, parseCueNumber } from "../cues/cueNumbers";
import { matchScore, rankItems } from "../shared/search";
import type { TabKey } from "../show/tabs";

export interface SearchHit {
  tab: TabKey;
  id: string;
  title: string;
  detail?: string;
}

export interface SearchGroup {
  tab: TabKey;
  label: string;
  hits: SearchHit[];
}

const clip = (s: string | null | undefined, n = 80) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Cue number match: 0 exact (14.2 = 14.20), 1 prefix, else null. */
function numberScore(q: string, number: string | null): number | null {
  const n = number?.trim();
  if (!n) return null;
  const qq = q.trim();
  if (!qq) return null;
  if (cueNumberKey(n) === cueNumberKey(qq)) return 0;
  if (n.toLowerCase().startsWith(qq.toLowerCase())) return 1;
  return null;
}

export function searchShow(data: ShowData, q: string, limit = 8): SearchGroup[] {
  if (!q.trim()) return [];
  const groups: SearchGroup[] = [];
  /** Each group's best score: 0 exact / 1 prefix name (or cue number) match, else 2+. */
  const best = new Map<SearchGroup, number>();
  const add = (g: SearchGroup, score: number | null) => {
    groups.push(g);
    best.set(g, score ?? 3);
  };
  const nameScore = (...names: (string | null | undefined)[]) =>
    Math.min(...names.map((n) => matchScore(q, [n]) ?? 3));
  const { tables, order } = data;

  // Cues: number matches first (exact, then prefix), then text matches, in show order.
  const cues = order.cues.map((id) => tables.cues.get(id)).filter((c) => !!c);
  const looksNumeric = parseCueNumber(q) !== null;
  const cueHits = cues
    .map((c, i) => {
      const ns = numberScore(q, c.number);
      const ts = looksNumeric ? null : matchScore(q, [c.description, c.sm_call, c.trigger_value]);
      const s = ns ?? (ts === null ? null : 2 + ts);
      return { c, s, i };
    })
    .filter((x) => x.s !== null)
    .sort((a, b) => (a.s as number) - (b.s as number) || a.i - b.i)
    .slice(0, limit);
  const cueBest = cueHits[0]?.s ?? null;
  const cueList = cueHits.map(({ c }) => ({
    tab: "cues" as const,
    id: c.id,
    title: c.number?.trim()
      ? `Cue ${c.number.trim()}`
      : c.is_section
        ? "Section"
        : "Cue (no number)",
    detail: clip(c.description || c.sm_call),
  }));
  if (cueList.length) add({ tab: "cues", label: "Cues", hits: cueList }, cueBest);

  const scenes = order.scenes.map((id) => tables.scenes.get(id)).filter((s) => !!s);
  const sceneRanked = rankItems(scenes, q, (s) => [sceneTitle(s), s.song], { limit });
  const sceneHits = sceneRanked.map((s) => ({
    tab: "scenes" as const,
    id: s.id,
    title: sceneTitle(s),
    detail: clip(s.song),
  }));
  if (sceneHits.length) {
    const s0 = sceneRanked[0];
    add(
      { tab: "scenes", label: "Scenes", hits: sceneHits },
      s0 ? nameScore(sceneTitle(s0), s0.name, s0.number) : null,
    );
  }

  const content = order.content.map((id) => tables.content.get(id)).filter((c) => !!c);
  const contentRanked = rankItems(content, q, (c) => [c.name], { limit });
  const contentHits = contentRanked.map((c) => ({
    tab: "content" as const,
    id: c.id,
    title: c.name || "(unnamed content)",
    detail: sceneTitle(c.scene_id ? tables.scenes.get(c.scene_id) : null),
  }));
  if (contentHits.length) {
    add({ tab: "content", label: "Content", hits: contentHits }, nameScore(contentRanked[0]?.name));
  }

  const surfaces = order.surfaces.map((id) => tables.surfaces.get(id)).filter((s) => !!s);
  const surfaceRanked = rankItems(surfaces, q, (s) => [s.name, s.channel], { limit });
  const surfaceHits = surfaceRanked.map((s) => ({
    tab: "surfaces" as const,
    id: s.id,
    title: s.name || s.channel || "(unnamed surface)",
    detail: clip(s.channel),
  }));
  if (surfaceHits.length) {
    add(
      { tab: "surfaces", label: "Surfaces", hits: surfaceHits },
      Math.min(...surfaceRanked.map((s) => nameScore(s.name, s.channel))),
    );
  }

  const notes = [...tables.notes.values()];
  const noteHits = rankItems(notes, q, (n) => [n.body], { limit }).map((n) => ({
    tab: "notes" as const,
    id: n.id,
    title: clip(n.body, 70) || "(empty note)",
    ...(n.status ? { detail: n.status } : {}),
  }));
  // Note bodies aren't names: never ranked above other groups.
  if (noteHits.length) add({ tab: "notes", label: "Notes", hits: noteHits }, null);

  const people = [...tables.persons.values()];
  const peopleRanked = rankItems(people, q, (p) => [p.name], { limit });
  const peopleHits = peopleRanked.map((p) => ({
    tab: "people" as const,
    id: p.id,
    title: p.name || "(no name)",
    detail: clip(p.role),
  }));
  if (peopleHits.length) {
    add({ tab: "people", label: "People", hits: peopleHits }, nameScore(peopleRanked[0]?.name));
  }

  // Groups with an exact or prefix name match (or cue number) come before groups with only
  // partial text matches ("C WALL" finds the surface before cues mentioning a wall);
  // otherwise the usual order.
  const tier = (g: SearchGroup) => ((best.get(g) ?? 3) <= 1 ? 0 : 1);
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => tier(a.g) - tier(b.g) || a.i - b.i)
    .map(({ g }) => g);
}
