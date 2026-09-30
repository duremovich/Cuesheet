import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { ShowResponse } from "../../shared/api";
import { AppHeader } from "../components/AppHeader";
import { PresenceIndicator } from "../components/PresenceIndicator";
import { ApiError, api } from "../lib/api";
import { useShowSocket } from "../lib/useShowSocket";
import styles from "./pages.module.css";

export function ShowPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<ShowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .getShow(id)
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof ApiError && e.status === 404 ? "Show not found" : String(e)),
      );
  }, [id]);

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
  const socket = useShowSocket(data.show.showId);
  return (
    <>
      <AppHeader>
        <h1 className={styles.showTitle} data-testid="show-name">
          {data.show.name}
        </h1>
        <PresenceIndicator {...socket} />
      </AppHeader>
      <main className={styles.showPage}>
        <div className={styles.gridPlaceholder} data-testid="cue-grid-placeholder">
          <div>
            <h2 style={{ marginBottom: 8 }}>Cue list</h2>
            <p style={{ margin: 0 }}>No cues yet. The cue grid arrives in M1.</p>
          </div>
        </div>
      </main>
    </>
  );
}
