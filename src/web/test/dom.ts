// Minimal helpers for React component tests in jsdom (no testing-library dependency).
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface Rendered {
  container: HTMLElement;
  root: Root;
  rerender(ui: ReactNode): void;
  unmount(): void;
}

const mounted = new Set<Root>();

/** Unmounts everything `render` mounted (called after each test). */
export function cleanup() {
  for (const r of mounted) act(() => r.unmount());
  mounted.clear();
}

export function render(ui: ReactNode): Rendered {
  const container = document.createElement("div");
  container.style.height = "600px";
  document.body.append(container);
  const root = createRoot(container);
  mounted.add(root);
  act(() => root.render(ui));
  return {
    container,
    root,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

type KeyOpts = { shift?: boolean; mod?: boolean; alt?: boolean };

/** Dispatches keydown on the focused element (or `target`). */
export function press(key: string, opts: KeyOpts = {}, target?: Element | null) {
  const el = target ?? document.activeElement ?? document.body;
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        shiftKey: !!opts.shift,
        ctrlKey: !!opts.mod,
        altKey: !!opts.alt,
      }),
    );
  });
}

/** Sets a controlled input's value the way a user would (fires React's onChange). */
export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function pointerDown(el: Element, opts: { shift?: boolean; mod?: boolean } = {}) {
  const Ctor = (window.PointerEvent ?? MouseEvent) as typeof MouseEvent;
  act(() => {
    el.dispatchEvent(
      new Ctor("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        shiftKey: !!opts.shift,
        ctrlKey: !!opts.mod,
      }),
    );
  });
}

export function click(el: Element, opts: { shift?: boolean; mod?: boolean } = {}) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        shiftKey: !!opts.shift,
        ctrlKey: !!opts.mod,
      }),
    );
  });
}

/** Lets timers (debounces, deferred blur checks) and promises settle. */
export async function wait(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

export function clipboardEvent(type: "copy" | "paste", data: Record<string, string> = {}) {
  const store = { ...data };
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    clipboardData: unknown;
  };
  Object.defineProperty(e, "clipboardData", {
    value: {
      getData: (t: string) => store[t] ?? "",
      setData: (t: string, v: string) => {
        store[t] = v;
      },
    },
  });
  return { event: e, store };
}
