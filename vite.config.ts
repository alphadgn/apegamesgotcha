// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Stub pngjs in the server build only: Privy's QR module eagerly loads qrcode's
// server entry, and pngjs's top-level util.inherits(...) crashes the deployed
// worker runtime. The browser build keeps the real pngjs so QR codes still render.
const stubPngjsOnServer = {
  name: "stub-pngjs-on-server",
  enforce: "pre" as const,
  resolveId(id: string, _importer: string | undefined, options?: { ssr?: boolean }) {
    if (id === "pngjs" && options?.ssr) {
      return new URL("./src/lib/pngjs-server-stub.ts", import.meta.url).pathname;
    }
    return null;
  },
};

export default defineConfig({
  vite: {
    plugins: [stubPngjsOnServer],
    resolve: {
      // Keep viem's optional socket transport compatible with the server runtime.
      alias: { isows: new URL("./src/lib/native-websocket.ts", import.meta.url).pathname },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
