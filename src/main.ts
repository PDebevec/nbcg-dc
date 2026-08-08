import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createAppRouter } from "@app/router";
import { boot } from "@app/boot";
import { logger } from "@lib/logger";

const app = createApp(App);
const pinia = createPinia();
const router = createAppRouter();

app.use(pinia);
app.use(router);

// Load config + configure the API client + initial connection check. Runs in
// the background; the shell renders immediately.
boot(pinia).catch((err) => logger.error("main", "Boot failed.", err));

app.mount("#app");
