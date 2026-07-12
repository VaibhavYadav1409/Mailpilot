import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import fs from "node:fs";
import electron from "vite-plugin-electron/simple";
import type { Plugin } from "vite";

// Electron's main-entry loader resolves ESM vs CommonJS from the nearest
// package.json "type" field rather than strictly honoring the .cjs
// extension. Since the app package.json has "type": "module" (needed for
// the Vite/React renderer code), we drop a small package.json into
// dist-electron/ to pin the compiled main/preload output to CommonJS.
function markDistElectronAsCjs(): Plugin {
  return {
    name: "mark-dist-electron-cjs",
    apply: "build",
    // Write this before the build emits anything (and well before Electron
    // is spawned) so there's no race between the file existing and
    // Electron trying to load main.cjs.
    buildStart() {
      const outDir = path.resolve(import.meta.dirname, "dist-electron");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );
    },
  };
}

// Same aliases as the renderer so electron/main.ts and preload.ts can use
// them too if needed.
const electronAlias = {
  "@": path.resolve(import.meta.dirname, "src"),
  "@shared": path.resolve(import.meta.dirname, "..", "shared"),
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // This is what actually launches the Electron desktop window in dev.
    // Without it, `vite` / `pnpm dev` only starts a browser-facing dev
    // server and nothing ever opens the app as a native window.
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          plugins: [markDistElectronAsCjs()],
          resolve: { alias: electronAlias },
          build: {
            outDir: "dist-electron",
            emptyOutDir: false,
            rollupOptions: {
              external: ["electron"],
              output: {
                format: "cjs",
                entryFileNames: "main.cjs",
              },
            },
          },
        },
      },
      preload: {
        // Sandboxed preload scripts (the Electron default) must be
        // CommonJS, so force .js/cjs output regardless of the package's
        // "type": "module" setting.
        input: path.join(import.meta.dirname, "electron/preload.ts"),
        vite: {
          plugins: [markDistElectronAsCjs()],
          resolve: { alias: electronAlias },
          build: {
            outDir: "dist-electron",
            emptyOutDir: false,
            rollupOptions: {
              external: ["electron"],
              output: {
                format: "cjs",
                entryFileNames: "preload.cjs",
              },
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "..", "shared"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname),
  publicDir: path.resolve(import.meta.dirname, "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 3002,
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: { strict: true, deny: ["**/.*"] },
    // Backend runs on :4000 (see backend/src/server.ts). Proxying here means
    // lib/api.ts can keep using relative "/api/..." URLs in dev instead of
    // needing VITE_API_URL set, and avoids CORS entirely for local dev.
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3002,
  },
});
