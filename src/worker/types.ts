import type { UserDTO } from "../shared/api";
import type { D1Db } from "./db/d1/client";

/** Hono environment shared by every route. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: D1Db;
    /** Set by `requireAuth`. */
    user: UserDTO;
    /** Raw session token, set by `requireAuth`. */
    sessionToken: string;
  };
}
