// A realistic 3-page musical scene for engine scenarios.
import type { BlockKind, ScriptText } from "../script";
import { normalizeText } from "../script";

export type Line = [BlockKind, string];

export const P1: Line[] = [
  ["heading", "ACT ONE"],
  ["heading", "SCENE 3: THE TRAIN PLATFORM"],
  [
    "direction",
    "(A deserted platform at night. Steam drifts across. JOE and JERRY enter, dragging instrument cases.)",
  ],
  ["character", "JOE"],
  [
    "dialogue",
    "We've got exactly four minutes before that train leaves, and I intend to be on it.",
  ],
  ["character", "JERRY"],
  ["dialogue", "Go."],
  ["character", "JOE"],
  ["dialogue", "Sweet Sue needs a sax and a bass, and I don't see anybody else volunteering."],
  ["character", "JERRY"],
  ["dialogue", "In a dress? In heels? On a train full of girls?"],
  ["direction", "(He looks down at his shoes.)"],
  ["character", "JOE"],
  ["dialogue", "Go."],
  ["direction", "(A whistle blows in the distance. The lights shift to a cold blue.)"],
];
export const P2: Line[] = [
  ["character", "JERRY"],
  ["dialogue", "Nobody's gonna buy it, Joe. Nobody in the whole wide world."],
  ["character", "JOE"],
  ["dialogue", "They'll buy it. People see what they expect to see."],
  ["heading", "No. 4 - RUNNIN' WILD"],
  ["character", "JOE"],
  ["lyric", "RUNNIN' WILD, LOST CONTROL"],
  ["lyric", "RUNNIN' WILD, MIGHTY BOLD"],
  ["character", "JERRY"],
  ["lyric", "FEELIN' GAY, RECKLESS TOO"],
  ["lyric", "CAREFREE MIND ALL THE TIME, NEVER BLUE"],
  ["direction", "(The ensemble swirls onto the platform with suitcases. Dance break.)"],
  ["character", "SUGAR"],
  ["dialogue", "Is this the car for Sweet Sue's Society Syncopators?"],
  ["character", "JERRY"],
  ["dialogue", "Go."],
];
export const P3: Line[] = [
  ["direction", "(SUGAR smiles, climbs aboard. JOE and JERRY exchange a look.)"],
  ["character", "JOE"],
  ["dialogue", "Well, that settles it. We're going to Florida."],
  ["character", "JERRY"],
  ["dialogue", "I always wanted to see Florida. I just never pictured doing it in a girdle."],
  ["direction", "(The train lurches. Blackout.)"],
  ["heading", "SCENE 4: THE TRAIN"],
  ["direction", "(Inside a sleeper car. Bunks line both walls.)"],
  ["character", "SWEET SUE"],
  ["dialogue", "Ladies! Rehearsal is at nine sharp, and anybody late gets the upper berth."],
  ["character", "JERRY"],
  ["dialogue", "Go."],
];

export function build(pages: Line[][], labels?: string[]): ScriptText {
  const blocks = [] as ScriptText["blocks"];
  pages.forEach((lines, p) => {
    for (const [kind, text] of lines)
      blocks.push({ i: blocks.length, page: p + 1, kind, text: normalizeText(text) });
  });
  return {
    blocks,
    pages: pages.map((_, p) => ({ page: p + 1, label: labels?.[p] ?? String(p + 14) })),
    source: "txt",
    confidence: 1,
  };
}
