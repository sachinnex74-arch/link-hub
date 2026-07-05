import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app")({
  // The real Tms UI is rendered by PersistentTmsHost in __root.tsx so that it
  // stays mounted across route switches. This route exists only to make /app
  // a valid URL and to flip the host into its visible state.
  ssr: false,
  component: AppRoute,
});

function AppRoute() {
  // Returning null is fine — the host renders the Tms tree at the root level
  // whenever the current pathname is /app.
  return null;
}
