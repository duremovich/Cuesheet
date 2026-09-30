// /shows/:id/*: loads the show (name, your role), then the show store and the workspace
// with one tab per core table (routes in main.tsx).
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { ShowResponse } from "../../shared/api";
import { AppHeader } from "../components/AppHeader";
import { ShowWorkspace } from "../features/show/ShowWorkspace";
import { ApiError, api } from "../lib/api";
import { useApiErrorHandler, useAuth } from "../lib/auth";
import { ShowStoreProvider } from "../lib/show-store";
import styles from "./pages.module.css";

export function ShowPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<ShowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleError = useApiErrorHandler();

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .getShow(id)
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof ApiError && e.status === 404 ? "Show not found" : handleError(e)),
      );
  }, [id, handleError]);

  if (error) {
    return (
      <>
        <AppHeader />
        <main className={styles.main}>
          <p className="error">{error}</p>
        </main>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <AppHeader />
        <p className="muted" style={{ padding: 24 }}>
          Loading…
        </p>
      </>
    );
  }
  return <LoadedShow data={data} />;
}

function LoadedShow({ data }: { data: ShowResponse }) {
  const { user } = useAuth();
  return (
    <ShowStoreProvider showId={data.show.showId} {...(user ? { userId: user.id } : {})}>
      <ShowWorkspace data={data} />
    </ShowStoreProvider>
  );
}
