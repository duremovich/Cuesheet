declare namespace Cloudflare {
  interface Env {
    /** Injected by vitest.config.ts for the worker test project only. */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite `?raw` imports (the example CSVs in import tests). */
declare module "*?raw" {
  const text: string;
  export default text;
}
