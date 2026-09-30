/// <reference types="node" />
// Guards the theme tokens: both themes define the same variables, and the text/background
// pairs we rely on meet WCAG AA (4.5:1).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function block(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const vars = new Map<string, string>();
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    vars.set(m[1] as string, (m[2] as string).trim());
  }
  return vars;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`expected #rrggbb, got ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  dark: block(':root[data-theme="dark"]'),
  light: block(':root[data-theme="light"]'),
};

const OPTION_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
];

describe("theme tokens", () => {
  it("defines the same variables in dark and light", () => {
    expect([...themes.light.keys()].sort()).toEqual([...themes.dark.keys()].sort());
  });

  for (const [name, vars] of Object.entries(themes)) {
    const v = (k: string) => {
      const value = vars.get(k);
      if (!value) throw new Error(`${name}: missing ${k}`);
      return value;
    };

    it(`${name}: text colors are AA on every background layer`, () => {
      for (const bg of ["--color-bg", "--color-surface", "--color-surface-raised"]) {
        for (const fg of [
          "--color-text",
          "--color-text-muted",
          "--color-accent",
          "--color-danger",
          "--color-warning",
          "--color-success",
        ]) {
          expect(contrast(v(fg), v(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: status text is AA on its subtle background`, () => {
      for (const s of ["danger", "warning", "success"]) {
        expect(contrast(v(`--color-${s}`), v(`--color-${s}-subtle`)), s).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      expect(contrast(v("--color-text-on-accent"), v("--color-accent"))).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    it(`${name}: select-option chips are AA`, () => {
      for (const c of OPTION_COLORS) {
        expect(contrast(v(`--option-${c}-fg`), v(`--option-${c}-bg`)), c).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }

  it("dark mode has no pure black or pure white surfaces", () => {
    for (const k of [
      "--color-bg-sunken",
      "--color-bg",
      "--color-surface",
      "--color-surface-raised",
      "--color-surface-hover",
    ]) {
      expect(["#000000", "#ffffff"]).not.toContain(themes.dark.get(k)?.toLowerCase());
    }
  });
});
