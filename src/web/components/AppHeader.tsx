import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { AccountMenu } from "./AccountMenu";
import styles from "./AppHeader.module.css";
import { ThemeToggle } from "./ThemeToggle";

/** Top bar on every page: brand, optional page-specific content, theme, user menu. */
export function AppHeader({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <header className={styles.header}>
      <Link to="/" className={styles.brand}>
        Cuesheet
      </Link>
      <div className={styles.middle}>{children}</div>
      <div className={styles.right}>
        <ThemeToggle />
        {user && (
          <>
            <span className={styles.user} data-testid="current-user">
              {user.name}
            </span>
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Sign out
            </button>
            <AccountMenu />
          </>
        )}
      </div>
    </header>
  );
}
