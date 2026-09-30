// The script anchoring engine (R20, decision 0004): pure functions shared by the Worker
// (re-anchoring on import) and the web client (placing cues, the resolve screen).
// States and thresholds: ./reanchor.ts; positions: ./text.ts; CLAUDE.md "Script".
export { diffPages, mapBlocks, type PageDiff, type PageStatus } from "./diff";
export { diceSimilarity } from "./fuzzy";
export {
  type AnchorInput,
  anchorStats,
  CONFIDENCE_CONTEXT,
  CONFIDENCE_EXACT,
  CONFIDENCE_QUOTE_ONLY,
  FUZZY_THRESHOLD,
  NEAR_BLOCKS,
  reanchor,
  WINDOW,
} from "./reanchor";
export {
  type AnchorSpan,
  anchorAt,
  anchorPosition,
  blockAt,
  type Joined,
  joinBlocks,
  makeAnchor,
  makePositionAnchor,
  POSITION_QUOTE_MAX,
  pageLabel,
  SEPARATOR,
  suggestSlot,
} from "./text";
