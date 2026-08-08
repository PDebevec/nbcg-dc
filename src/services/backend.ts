/**
 * Holds the singleton {@link ApiClient} for the backend, (re)configured from
 * settings whenever the base URL / token change. Every resource service reads
 * the current client via {@link getApiClient}, so a config change takes effect
 * everywhere without threading the client through call sites.
 *
 * Configured by the settings store (application layer) — this module never
 * imports a store, keeping the dependency direction domain ← services ← stores.
 */

import { ApiClient, type ApiClientOptions } from "./api/client";

let client: ApiClient | null = null;

export function configureApiClient(options: ApiClientOptions): ApiClient {
  client = new ApiClient(options);
  return client;
}

/**
 * Build a **throwaway** client without touching the singleton.
 *
 * Settings → Test connection has to probe the values currently *in the form*,
 * which are not yet saved — reconfiguring the singleton to test them would point
 * the whole app at an unverified (possibly broken) host, and a failed test would
 * leave it there. So the draft gets its own client and the singleton keeps
 * serving the saved config until Save succeeds.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

export function isApiClientConfigured(): boolean {
  return client !== null;
}

export function getApiClient(): ApiClient {
  if (!client) {
    throw new Error(
      "API client not configured — call configureApiClient() during boot.",
    );
  }
  return client;
}
