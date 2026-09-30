import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import type { UserDTO } from "../../shared/api";
import { ApiError, api } from "./api";

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
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
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
