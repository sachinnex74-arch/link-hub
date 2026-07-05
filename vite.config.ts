import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Inside the Lovable sandbox the preset always builds for Cloudflare (for previews).
// For external builds (Vercel CI) we target the Nitro `vercel` preset, which emits
// `.vercel/output/` that Vercel auto-detects — no vercel.json needed.
export default defineConfig({
  nitro: {
    preset: "vercel",
  },
});
