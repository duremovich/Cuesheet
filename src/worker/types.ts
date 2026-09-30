import type { UserDTO } from "../shared/api";
import type { ShareScope } from "../shared/share";
import type { D1Db } from "./db/d1/client";

/** Hono environment shared by every route. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: D1Db;
    /** Set by `requireAuth` (for a share link's viewer: a stand-in; see `share`). */
    user: UserDTO;
    /** Raw session token, set by `requireAuth` (empty for a share link's viewer). */
    sessionToken: string;
    /**
     * Set when the request is a share link's viewer (routes/share.ts
     * `requireAuthOrShare`): what the link may read. Only a few GET routes admit it.
     */
    share?: ShareScope;
  };
}
