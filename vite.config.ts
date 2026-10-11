// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const privyServerStub = new URL("./src/lib/privy-server-stub.ts", import.meta.url).pathname;

export default defineConfig({
  vite: {
    plugins: [
      {
        // Server builds get an inert @privy-io/react-auth (src/lib/privy-server-stub.ts). With the real one,
        // viem's core landed in Privy's server chunk, so every Chainlink VRF / NFT server call loaded Privy's
        // Node-only logger (pino + sonic-boom), whose util.inherits(...) crashes the worker runtime with
        // `The "superCtor.prototype" property must be of type object`. Browsers still get the real package.
        name: "privy-browser-only",
        enforce: "pre",
        resolveId(source) {
          if (source !== "@privy-io/react-auth") return null;
          const consumer = (this as { environment?: { config?: { consumer?: string } } }).environment?.config
            ?.consumer;
          return consumer === "server" ? privyServerStub : null;
        },
      },
    ],
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
