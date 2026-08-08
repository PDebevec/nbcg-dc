/**
 * Application-level constants and identity. Persisted, user-editable settings
 * live in the settings store + `services/config`; this file holds only static
 * app facts.
 */

/** Display name (rail identity block, window title). */
export const APP_NAME = "NBCG Archive";

/** App version. Keep in sync with `package.json` (Settings → App version). */
export const APP_VERSION = "0.1.0";

/** Backend reachability re-check interval (ms). Footer polls at this cadence. */
export const CONNECTION_POLL_INTERVAL_MS = 60_000;
