// Rendering script text: one block (by kind: headings bold, character names small caps
// centred, dialogue indented, directions italic), with quoted ranges underlined. The
// reader, the Resolve screen and the calling-script print all use it. Each block is
// `[data-block=<i>]` with its text in `[data-text]` (and nothing else), which is what
// selection → anchor (placement.ts `rangeToSpan`) relies on.
import type { ReactNode } from "react";
import type { ScriptBlock } from "./contract";
import { segmentText } from "./markers";
import styles from "./Script.module.css";

export interface QuoteRange {
  id: string;
  start: number;
  end: number;
}

export function BlockText({
  block,
  quotes,
  hot,
  highlight,
  children,
  ...rest
}: {
  block: ScriptBlock;
  /** Ranges to underline (anchor ids). */
  quotes?: readonly QuoteRange[];
  /** Anchor ids drawn emphasised (hovered or flashing marker). */
  hot?: ReadonlySet<string>;
  /** The whole block highlighted (a positional candidate). */
  highlight?: boolean;
  /** After the text (badges on phones). */
  children?: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  const segments = segmentText(block.text, quotes ?? []);
  return (
    <div
      {...rest}
      className={`${styles.block} ${styles[block.kind] ?? ""} ${rest.className ?? ""}`}
      data-block={block.i}
      data-kind={block.kind}
      data-highlight={highlight || undefined}
    >
      <span data-text="">
        {segments.map((s, k) =>
          s.ids.length ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              key={k}
              className={styles.quote}
              data-quote={s.ids.join(" ")}
              data-hot={s.ids.some((id) => hot?.has(id)) || undefined}
            >
              {s.text}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            <span key={k}>{s.text}</span>
          ),
        )}
      </span>
      {children}
    </div>
  );
}
