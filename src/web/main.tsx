import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router";
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
  { path: "/shows/:id", element: <RequireAuth>{() => <ShowPage />}</RequireAuth> },
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

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
