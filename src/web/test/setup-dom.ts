// Setup for the jsdom Vitest project (React component tests).
import { afterEach } from "vitest";
import { cleanup } from "./dom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout. Give elements a size so virtualized lists render rows.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return 600;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 1000;
  },
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
