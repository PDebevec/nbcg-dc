// Fonts (bundled — the desktop app must not fetch from the network) + design
// system. Weights per the v1.4.0 prototype: sans 400/500/600/700, mono 400/500.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./design/tokens.css";
import "./design/global.css";

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
