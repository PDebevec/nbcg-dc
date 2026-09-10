import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
// @ts-expect-error type error without @types/node package
import { fileURLToPath, URL } from "node:url";

// Path aliases — kept in sync with tsconfig.json + vite.config.ts so the logic
// lane's unit tests resolve `@domain`/`@services`/etc. exactly as the app does.
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

export default defineConfig({
  // The logic lane's tests never touch the DOM, but the Processing tab's
  // template is real work that `vue-tsc` cannot fully check, so it is
  // smoke-rendered through `vue/server-renderer` - which still needs .vue
  // files compiled.
  plugins: [vue()],
  resolve: { alias },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
