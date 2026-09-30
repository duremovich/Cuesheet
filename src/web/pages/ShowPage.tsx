import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { ShowResponse } from "../../shared/api";
import { AddCueForm } from "../components/AddCueForm";
import { AppHeader } from "../components/AppHeader";
import { CueListPlain } from "../components/CueListPlain";
import { ImportAirtableButton } from "../components/ImportAirtableButton";
import { PresenceIndicator } from "../components/PresenceIndicator";
import { ApiError, api } from "../lib/api";
import { useApiErrorHandler, useAuth } from "../lib/auth";
import { ShowStoreProvider, useShowSocketState } from "../lib/show-store";
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
      <ShowContent data={data} />
    </ShowStoreProvider>
  );
}

function ShowContent({ data }: { data: ShowResponse }) {
  const socket = useShowSocketState();
  const canEdit = data.role === "owner" || data.role === "editor";
  return (
    <>
      <AppHeader>
        <h1 className={styles.showTitle} data-testid="show-name">
          {data.show.name}
        </h1>
        <PresenceIndicator {...socket} />
      </AppHeader>
      <main className={styles.showPage}>
        <div className={styles.showToolbar}>
          <h2>Cue list</h2>
          {canEdit && <ImportAirtableButton showId={data.show.showId} />}
        </div>
        <CueListPlain />
        {canEdit && <AddCueForm />}
      </main>
    </>
  );
}
