// Synthetic scripts for the anchoring tests (not used by the app).
import type { BlockKind, ScriptText } from "../script";

const WORDS = (
  "the a and to of in that is it you he she was for on are with as his they be at one have this " +
  "from or had by hot word but what some we can out other were all there when up use your how " +
  "said an each which do their time if will way about many then them write would like so these " +
  "her long make thing see him two has look more day could go come did number sound no most " +
  "people my over know water than call first who may down side been now find any new work part " +
  "take get place made live where after back little only round man year came show every good " +
  "me give our under name very through just form sentence great think say help low line differ " +
  "turn cause much mean before move right boy old too same tell does set three want air well also " +
  "play small end put home read hand port large spell add even land here must big high such " +
  "follow act why ask men change went light kind off need house picture try us again animal " +
  "point mother world near build self earth father head stand own page should country found " +
  "answer school grow study still learn plant cover food sun four between state keep eye never " +
  "last let thought city tree cross farm hard start might story saw far sea draw left late run"
).split(" ");

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` distinct-ish lines of 6–18 words. */
export function lines(n: number, seed = 1): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 6 + Math.floor(r() * 13);
    const words: string[] = [];
    for (let w = 0; w < len; w++) words.push(WORDS[Math.floor(r() * WORDS.length)] as string);
    const s = words.join(" ");
    out.push(`${s[0]?.toUpperCase()}${s.slice(1)}.`);
  }
  return out;
}

const KINDS: BlockKind[] = ["character", "dialogue", "direction", "dialogue"];

/** A ScriptText from lines, `perPage` blocks per page (labels "1", "2", …). */
export function script(
  texts: string[],
  perPage = 30,
  labels?: (page: number) => string,
): ScriptText {
  const blocks = texts.map((text, i) => ({
    i,
    page: Math.floor(i / perPage) + 1,
    kind: KINDS[i % KINDS.length] as BlockKind,
    text,
  }));
  const pageCount = Math.max(1, Math.ceil(texts.length / perPage));
  return {
    blocks,
    pages: Array.from({ length: pageCount }, (_, k) => ({
      page: k + 1,
      label: labels ? labels(k + 1) : String(k + 1),
    })),
    source: "txt",
    confidence: 1,
  };
}
