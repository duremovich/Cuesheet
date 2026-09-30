import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Link,
  Navigate,
  RouterProvider,
  useLocation,
  useParams,
} from "react-router";
import { ContentGrid } from "./features/content/ContentGrid";
import { CueGrid } from "./features/cues/CueGrid";
import { NotesGrid } from "./features/notes/NotesGrid";
import { PeopleGrid } from "./features/people/PeopleGrid";
import { QuickAddPage } from "./features/quick/QuickAddPage";
import { SceneGrid } from "./features/scenes/SceneGrid";
import { TechPage } from "./features/tech/TechPage";
import { AuthProvider, RequireAuth } from "./lib/auth";
import { devRoutes } from "./pages/dev/routes";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { ShowPage } from "./pages/ShowPage";
import { ShowsPage } from "./pages/ShowsPage";
import "./styles/global.css";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  { path: "/", element: <RequireAuth>{(user) => <ShowsPage user={user} />}</RequireAuth> },
  {
    path: "/shows/:id",
    element: <RequireAuth>{() => <ShowPage />}</RequireAuth>,
    children: [
      { index: true, element: <ToCues /> },
      { path: "cues", element: <CueGrid /> },
      { path: "scenes", element: <SceneGrid /> },
      { path: "content", element: <ContentGrid /> },
      { path: "notes", element: <NotesGrid /> },
      { path: "people", element: <PeopleGrid /> },
      { path: "tech", element: <TechPage /> },
      { path: "quick", element: <QuickAddPage /> },
      { path: "*", element: <ToCues /> },
    ],
  },
  ...devRoutes,
  {
    path: "*",
    element: (
      <main style={{ padding: 24 }}>
        <p>Page not found.</p>
        <Link to="/">Back to shows</Link>
      </main>
    ),
  },
]);

/** /shows/:id (and unknown tabs) → the Cues tab, keeping ?cue= etc. */
function ToCues() {
  const { id = "" } = useParams();
  const { search } = useLocation();
  return <Navigate to={{ pathname: `/shows/${encodeURIComponent(id)}/cues`, search }} replace />;
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
