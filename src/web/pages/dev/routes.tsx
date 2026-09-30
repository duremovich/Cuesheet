// Developer-only pages. They exist in `vite dev` and in builds made with
// VITE_DEV_PAGES=1 (the e2e build); production builds drop them, including the example
// data they embed, because the condition below is a build-time constant.

import type { RouteObject } from "react-router";

const ENABLED = import.meta.env.DEV || import.meta.env.VITE_DEV_PAGES === "1";

export const devRoutes: RouteObject[] = ENABLED
  ? [
      {
        path: "/dev/grid",
        lazy: async () => ({ Component: (await import("./GridDevPage")).GridDevPage }),
        HydrateFallback: () => null,
      },
    ]
  : [];
