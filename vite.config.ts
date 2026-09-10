import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { fileURLToPath, URL } from "node:url";
const host = process.env.TAURI_DEV_HOST;

// Path aliases — keep in sync with tsconfig.json compilerOptions.paths.
const alias = {
  "@app": fileURLToPath(new URL("./src/app", import.meta.url)),
  "@domain": fileURLToPath(new URL("./src/domain", import.meta.url)),
  "@services": fileURLToPath(new URL("./src/services", import.meta.url)),
  "@ipc": fileURLToPath(new URL("./src/ipc", import.meta.url)),
  "@stores": fileURLToPath(new URL("./src/stores", import.meta.url)),
  "@composables": fileURLToPath(new URL("./src/composables", import.meta.url)),
  "@ui": fileURLToPath(new URL("./src/components", import.meta.url)),
  "@lib": fileURLToPath(new URL("./src/lib", import.meta.url)),
};

// https://vite.dev/config/
export default defineConfig(() => ({
  resolve: { alias },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // …and the scan roots, which sit inside the repo on the dev machine
      // (`arh/` unprocessed, `processed/` published) and hold gigabytes the
      // app itself is writing, moving and locking. The same exclusions are
      // already in `pyrightconfig.json` and `.vscode/settings.json`; the dev
      // server never got them, so it was watching ~3 GB of scans and died
      // with `EBUSY … watch 'processed/Pisma iz Liona/metadata.json'` the
      // moment an upload moved a folder out from under it.
      //
      // Both forms per directory on purpose: `**/arh/**` matches what is
      // inside it, `**/arh` the directory node itself.
      ignored: [
        "**/src-tauri/**",
        "**/arh",
        "**/arh/**",
        "**/processed",
        "**/processed/**",
      ],
    },
  },

  plugins: [
    vue(),
    {
      // A watcher error must not take the dev server with it.
      //
      // chokidar re-emits a failed `fs.watch` as an `error` event, and an
      // `error` with no listener is a hard Node crash — which then fails
      // Tauri's `beforeDevCommand` and kills the whole session. Windows
      // hands out `EBUSY` for any file something else holds open, so this is
      // reachable whenever the app and the dev server touch the same path,
      // exclusions or not. Log it and carry on: a missed watch costs one
      // manual reload, not the session.
      name: "nbcg-tolerate-watcher-errors",
      apply: "serve" as const,
      configureServer(server: { watcher: { on: (e: string, cb: (err: Error) => void) => void } }) {
        server.watcher.on("error", (err: Error) => {
          console.warn(`[vite] file watcher error (ignored): ${err.message}`);
        });
      },
    },
  ],
}));
