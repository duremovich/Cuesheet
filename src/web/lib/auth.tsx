import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import type { UserDTO } from "../../shared/api";
import { api, UnauthorizedError } from "./api";

interface AuthState {
  /** undefined while the initial /api/me is in flight. */
  user: UserDTO | null | undefined;
  setUser: (u: UserDTO | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((r) => !cancelled && setUser(r.user))
      .catch((e: unknown) => {
        if (!cancelled) setUser(null);
        console.error(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  return <AuthContext value={{ user, setUser, logout }}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/**
 * Central handling for errors from `api` calls on signed-in pages. A 401 (expired or
 * revoked session) signs the client out, so `RequireAuth` redirects to
 * /login?next=<current path>, and returns null. Anything else becomes a message to show.
 */
export function useApiErrorHandler(): (e: unknown) => string | null {
  const { setUser } = useAuth();
  return useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        setUser(null);
        return null;
      }
      return e instanceof Error ? e.message : String(e);
    },
    [setUser],
  );
}

/** Renders children for signed-in users; sends everyone else to /login?next=... */
export function RequireAuth({ children }: { children: (user: UserDTO) => ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined)
    return (
      <p className="muted" style={{ padding: 24 }}>
        Loading…
      </p>
    );
  if (user === null) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children(user);
}
