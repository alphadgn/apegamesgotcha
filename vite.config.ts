// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    resolve: {
      alias: {
        // Keep viem's optional socket transport compatible with the server runtime.
        isows: new URL("./src/lib/native-websocket.ts", import.meta.url).pathname,
        // Stub pngjs everywhere: Privy's QR module eagerly loads qrcode's server
        // entry, and pngjs's top-level util.inherits(...) crashes the deployed
        // worker runtime. Browser QR codes use the canvas renderer, not pngjs.
        pngjs: new URL("./src/lib/pngjs-server-stub.ts", import.meta.url).pathname,
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
