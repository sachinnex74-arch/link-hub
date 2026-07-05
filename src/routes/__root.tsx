import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useRef, useState, lazy, Suspense } from "react";

import appCss from "../styles.css?url";
import { initSync } from "@/lib/supaSync";

// Lazy so it isn't pulled into the initial bundle for /login, /driver, etc.
const Tms = lazy(() => import("@/components/Tms.jsx"));

/**
 * Keeps the TMS app (Load Board, Fleet, TAT, etc.) mounted across route
 * switches. Without this, navigating /app -> /gps -> /app remounts the whole
 * Tms tree and re-renders thousands of load rows (~500-600ms).
 *
 * Behavior:
 *  - Tms is mounted lazily on the first visit to /app.
 *  - On other routes (/gps, /control, /logs, /geofences, /driver, /login,
 *    /index) it stays mounted but is hidden via display:none, so its sync,
 *    polling, mirror flushes, and state stay alive.
 *  - On routes where Tms is hidden, the route's own Outlet still renders
 *    normally above it.
 */
function PersistentTmsHost() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onApp = pathname === "/app";
  // Client-only mount: Tms reads localStorage at module/component scope and
  // would crash during SSR. We also keep the "ever visited /app" gate so
  // routes like /login or /driver never mount Tms at all until the user
  // actually opens the app.
  const [mounted, setMounted] = useState(false);
  const everVisitedRef = useRef(false);
  useEffect(() => {
    if (onApp) everVisitedRef.current = true;
    if (everVisitedRef.current && !mounted) setMounted(true);
  }, [onApp, mounted]);
  if (!mounted) return null;
  return (
    <div
      aria-hidden={!onApp}
      style={{
        display: onApp ? "block" : "none",
        position: onApp ? "relative" : "absolute",
        inset: onApp ? "auto" : 0,
        width: "100%",
        height: onApp ? "auto" : 0,
        overflow: onApp ? "visible" : "hidden",
      }}
    >
      <Suspense fallback={null}>
        <Tms />
      </Suspense>
    </div>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/app"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/app"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "FleetCommand TMS — NS Logistics" },
      { name: "description", content: "FleetCommand TMS — Pan-India Road Freight Operations" },
      { name: "theme-color", content: "#0c1120" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ background: "#f2f4f7", margin: 0, padding: 0 }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onApp = pathname === "/app";

  useEffect(() => { void initSync(); }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Other routes render here; on /app the Outlet renders a tiny
          placeholder and the real UI comes from PersistentTmsHost below. */}
      <div style={{ display: onApp ? "none" : "contents" }}>
        <Outlet />
      </div>
      <PersistentTmsHost />
    </QueryClientProvider>
  );
}
