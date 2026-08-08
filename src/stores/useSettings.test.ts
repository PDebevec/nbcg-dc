import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { DEFAULT_CONFIG, type AppConfig, type RootKey } from "@domain/config";

/** A shape-valid (not real) JWT. */
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJuYmNnIn0.c2lnbmF0dXJl";
const JWT2 = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.c2lnbmF0dXJl";

// ── the service layer this store sits on, faked ────────────────────────────
// The store's job is orchestration (draft vs saved, ordering, when the client is
// rebuilt), so the services are stubs and the assertions are about the calls.

const state = {
  saved: { ...DEFAULT_CONFIG } as AppConfig,
  token: null as string | null,
  pathExists: true,
  picked: null as string | null,
};

const calls = {
  saveConfig: [] as AppConfig[],
  setApiToken: [] as string[],
  configureApiClient: [] as Array<{ baseUrl: string; apiPrefix: string }>,
  createApiClient: [] as Array<{ baseUrl: string; apiPrefix: string }>,
  checkConnection: 0,
  refreshSchema: 0,
};

vi.mock("@services/config", () => ({
  loadConfig: async () => ({ ...state.saved }),
  saveConfig: async (config: AppConfig) => {
    // Mirrors the real service: persists the canonical form and returns it.
    const { normalizeConfig } = await import("@domain/config");
    const normalized = normalizeConfig(config);
    calls.saveConfig.push(normalized);
    state.saved = normalized;
    return normalized;
  },
  getApiToken: async () => state.token,
  setApiToken: async (token: string) => {
    calls.setApiToken.push(token);
    state.token = token || null;
  },
  probeRoots: async (config: Pick<AppConfig, RootKey>) => ({
    unprocessedRoot: {
      key: "unprocessedRoot" as const,
      path: config.unprocessedRoot,
      validity: config.unprocessedRoot
        ? state.pathExists
          ? ("valid" as const)
          : ("invalid" as const)
        : ("not-set" as const),
    },
    processedRoot: {
      key: "processedRoot" as const,
      path: config.processedRoot,
      validity: config.processedRoot
        ? state.pathExists
          ? ("valid" as const)
          : ("invalid" as const)
        : ("not-set" as const),
    },
  }),
  pickDirectory: async () => state.picked,
  getAppVersion: async () => "9.9.9",
}));

vi.mock("@services/backend", () => ({
  configureApiClient: (options: { baseUrl: string; apiPrefix: string }) => {
    calls.configureApiClient.push({
      baseUrl: options.baseUrl,
      apiPrefix: options.apiPrefix,
    });
    return {} as unknown;
  },
  createApiClient: (options: { baseUrl: string; apiPrefix: string }) => {
    calls.createApiClient.push({
      baseUrl: options.baseUrl,
      apiPrefix: options.apiPrefix,
    });
    return { marker: "throwaway" } as unknown;
  },
}));

vi.mock("@services/api", () => ({
  checkConnection: async (_client: unknown, options?: { baseUrl?: string }) => {
    calls.checkConnection += 1;
    return {
      reachable: true,
      reason: "ok" as const,
      status: 200,
      message: `ok ${options?.baseUrl ?? ""}`.trim(),
      checkedAt: new Date().toISOString(),
    };
  },
  refreshRecordSchema: async () => {
    calls.refreshSchema += 1;
    return {
      ok: true,
      stale: false,
      levels: [
        { level: "main" as const, fieldCount: 41, fetchedAt: null, etag: null, fresh: true },
        { level: "child" as const, fieldCount: 31, fetchedAt: null, etag: null, fresh: true },
      ],
      message: "Metadata schema refreshed (main 41, child 31 fields).",
    };
  },
  recordSchemaCacheInfo: () => [],
}));

const { useSettingsStore } = await import("./useSettings");

beforeEach(() => {
  setActivePinia(createPinia());
  state.saved = { ...DEFAULT_CONFIG };
  state.token = null;
  state.pathExists = true;
  state.picked = null;
  calls.saveConfig = [];
  calls.setApiToken = [];
  calls.configureApiClient = [];
  calls.createApiClient = [];
  calls.checkConnection = 0;
  calls.refreshSchema = 0;
});

/** A loaded store with a realistic saved config. */
async function loadedStore() {
  state.saved = {
    ...DEFAULT_CONFIG,
    backendBaseUrl: "http://localhost:3000",
    unprocessedRoot: "C:/scans",
    processedRoot: "C:/done",
  };
  state.token = JWT;
  const store = useSettingsStore();
  await store.load();
  return store;
}

describe("load", () => {
  it("loads config + token, configures the client, and seeds the draft", async () => {
    const store = await loadedStore();

    expect(store.loaded).toBe(true);
    expect(store.config.backendBaseUrl).toBe("http://localhost:3000");
    expect(store.hasToken).toBe(true);
    expect(store.configured).toBe(true);
    expect(store.draft).toEqual(store.config);
    expect(store.dirty).toBe(false);
    expect(calls.configureApiClient).toEqual([
      { baseUrl: "http://localhost:3000", apiPrefix: "/api" },
    ]);
  });

  it("resolves the app version and root validity", async () => {
    const store = await loadedStore();
    expect(store.appVersion).toBe("9.9.9");
    expect(store.roots.unprocessedRoot.validity).toBe("valid");
    expect(store.roots.processedRoot.validity).toBe("valid");
  });

  it("reports an unset root as not-set and a missing one as invalid", async () => {
    state.pathExists = false;
    state.saved = { ...DEFAULT_CONFIG, unprocessedRoot: "C:/gone" };
    const store = useSettingsStore();
    await store.load();
    expect(store.roots.unprocessedRoot.validity).toBe("invalid");
    expect(store.roots.processedRoot.validity).toBe("not-set");
  });
});

describe("draft editing", () => {
  it("does not touch the saved config or the client", async () => {
    const store = await loadedStore();
    calls.configureApiClient = [];

    store.editDraft({ backendBaseUrl: "https://api.nbcg.me" });

    expect(store.dirty).toBe(true);
    expect(store.config.backendBaseUrl).toBe("http://localhost:3000");
    expect(calls.saveConfig).toEqual([]);
    expect(calls.configureApiClient).toEqual([]);
  });

  it("ignores a change that normalises back to the saved value", async () => {
    const store = await loadedStore();
    // A trailing slash is not a real edit.
    store.editDraft({ backendBaseUrl: "http://localhost:3000/" });
    expect(store.dirty).toBe(false);
  });

  it("blocks Save while the draft URL is invalid", async () => {
    const store = await loadedStore();
    store.editDraft({ backendBaseUrl: "localhost:3000" });

    expect(store.validation.valid).toBe(false);
    expect(store.validation.errors.backendBaseUrl).toBeTruthy();
    expect(store.canSave).toBe(false);
    await expect(store.save()).resolves.toBe(false);
    expect(calls.saveConfig).toEqual([]);
  });

  it("allows Save with an odd-looking token (warning, not error)", async () => {
    const store = await loadedStore();
    store.editToken("garbage");

    expect(store.validation.warnings.apiToken).toBeTruthy();
    expect(store.validation.valid).toBe(true);
    expect(store.canSave).toBe(true);
  });

  it("revert discards edits and the test result", async () => {
    const store = await loadedStore();
    store.editDraft({ backendBaseUrl: "https://api.nbcg.me" });
    store.editToken(JWT2);
    await store.testConnection();
    expect(store.testResult).not.toBeNull();

    store.revert();

    expect(store.draft).toEqual(store.config);
    expect(store.draftToken).toBeNull();
    expect(store.dirty).toBe(false);
    expect(store.testResult).toBeNull();
  });
});

describe("save", () => {
  it("persists the canonical config, then the token, then rebuilds the client", async () => {
    const store = await loadedStore();
    calls.configureApiClient = [];
    store.editDraft({ backendBaseUrl: "  https://api.nbcg.me/  ", apiPrefix: "api/" });
    store.editToken(`Bearer ${JWT2}`);

    await expect(store.save()).resolves.toBe(true);

    expect(calls.saveConfig).toEqual([
      expect.objectContaining({
        backendBaseUrl: "https://api.nbcg.me",
        apiPrefix: "/api",
      }),
    ]);
    // The token is stored normalised — no "Bearer " prefix reaches the store.
    expect(calls.setApiToken).toEqual([JWT2]);
    // The client is rebuilt once the new config AND token are both in place.
    expect(calls.configureApiClient).toEqual([
      { baseUrl: "https://api.nbcg.me", apiPrefix: "/api" },
    ]);
    expect(store.dirty).toBe(false);
    expect(store.draft).toEqual(store.config);
  });

  it("does not write the token when it was not edited", async () => {
    const store = await loadedStore();
    store.editDraft({ backendBaseUrl: "https://api.nbcg.me" });

    await store.save();

    expect(calls.setApiToken).toEqual([]);
    expect(store.apiToken).toBe(JWT);
  });

  it("clears the token when the field is emptied", async () => {
    const store = await loadedStore();
    store.editToken("");

    expect(store.dirty).toBe(true);
    await store.save();

    expect(calls.setApiToken).toEqual([""]);
    expect(store.apiToken).toBeNull();
    expect(store.hasToken).toBe(false);
  });

  it("re-probes the roots after saving new paths", async () => {
    const store = await loadedStore();
    store.editDraft({ processedRoot: "C:/elsewhere" });
    await store.save();
    expect(store.roots.processedRoot.path).toBe("C:/elsewhere");
  });

  it("keeps the draft and reports false when persistence fails", async () => {
    const store = await loadedStore();
    const config = await import("@services/config");
    vi.spyOn(config, "saveConfig").mockRejectedValueOnce(new Error("disk full"));

    store.editDraft({ backendBaseUrl: "https://api.nbcg.me" });
    await expect(store.save()).resolves.toBe(false);

    expect(store.config.backendBaseUrl).toBe("http://localhost:3000");
    expect(store.draft.backendBaseUrl).toBe("https://api.nbcg.me");
    expect(store.dirty).toBe(true);
    expect(store.saving).toBe(false);
  });

  // The config write can succeed and the token write fail. `config` is what the
  // UI shows as the current host; `configureApiClient` is where calls actually
  // go. Committing the config before the token write settled left those two
  // pointing at different backends while `save()` reported failure.
  it("does not move the app to the new host when the token write fails", async () => {
    const store = await loadedStore();
    const config = await import("@services/config");
    vi.spyOn(config, "setApiToken").mockRejectedValueOnce(new Error("keyring locked"));

    const clientCalls = calls.configureApiClient.length;
    store.editDraft({ backendBaseUrl: "https://api.nbcg.me" });
    store.editToken(JWT2);
    await expect(store.save()).resolves.toBe(false);

    // Saved state and the live client agree: neither moved.
    expect(store.config.backendBaseUrl).toBe("http://localhost:3000");
    expect(calls.configureApiClient.length).toBe(clientCalls);
    // The edits survive so the operator can retry.
    expect(store.draft.backendBaseUrl).toBe("https://api.nbcg.me");
    expect(store.dirty).toBe(true);
  });
});

describe("token display", () => {
  it("masks the saved token and never exposes it", async () => {
    const store = await loadedStore();
    expect(store.tokenDisplay.present).toBe(true);
    expect(store.tokenDisplay.jwtShaped).toBe(true);
    expect(store.tokenDisplay.masked).toMatch(/^•+$/);
    expect(store.tokenDisplay.masked).not.toContain("ey");
  });

  it("reflects a cleared field before saving", async () => {
    const store = await loadedStore();
    store.editToken("");
    expect(store.tokenDisplay.present).toBe(false);
    expect(store.tokenDisplay.masked).toBe("");
  });
});

describe("testConnection", () => {
  it("probes the DRAFT url with a throwaway client, leaving the app pointed at the saved one", async () => {
    const store = await loadedStore();
    calls.configureApiClient = [];
    store.editDraft({ backendBaseUrl: "https://api.nbcg.me" });

    const result = await store.testConnection();

    expect(result?.reachable).toBe(true);
    expect(calls.createApiClient).toEqual([
      { baseUrl: "https://api.nbcg.me", apiPrefix: "/api" },
    ]);
    // Crucially: the singleton was NOT repointed at the unverified host.
    expect(calls.configureApiClient).toEqual([]);
    expect(store.config.backendBaseUrl).toBe("http://localhost:3000");
    expect(store.testing).toBe(false);
  });

  it("normalises the draft url before probing", async () => {
    const store = await loadedStore();
    store.editDraft({ backendBaseUrl: "  https://api.nbcg.me/  ", apiPrefix: "api" });
    await store.testConnection();
    expect(calls.createApiClient[0]).toEqual({
      baseUrl: "https://api.nbcg.me",
      apiPrefix: "/api",
    });
  });

  it("refuses to probe an invalid url rather than reporting it unreachable", async () => {
    const store = await loadedStore();
    store.editDraft({ backendBaseUrl: "not-a-url" });

    await expect(store.testConnection()).resolves.toBeNull();
    expect(calls.checkConnection).toBe(0);
    expect(store.testResult).toBeNull();
  });
});

describe("refreshSchema", () => {
  it("refreshes both levels and records the cache state", async () => {
    const store = await loadedStore();
    const result = await store.refreshSchema();

    expect(calls.refreshSchema).toBe(1);
    expect(result?.ok).toBe(true);
    expect(store.schemaCache.map((l) => l.fieldCount)).toEqual([41, 31]);
    expect(store.refreshingSchema).toBe(false);
  });
});

describe("update / setTheme / updateToken (immediate writes)", () => {
  it("update persists and reconfigures immediately", async () => {
    const store = await loadedStore();
    calls.configureApiClient = [];

    await store.update({ backendBaseUrl: "https://api.nbcg.me" });

    expect(store.config.backendBaseUrl).toBe("https://api.nbcg.me");
    expect(calls.configureApiClient).toHaveLength(1);
    // An untouched draft follows the saved config rather than looking dirty.
    expect(store.dirty).toBe(false);
    expect(store.draft.backendBaseUrl).toBe("https://api.nbcg.me");
  });

  it("update does not clobber a draft the operator is editing", async () => {
    const store = await loadedStore();
    store.editDraft({ processedRoot: "C:/mine" });

    await store.update({ theme: "dark" });

    expect(store.draft.processedRoot).toBe("C:/mine");
    expect(store.dirty).toBe(true);
  });

  it("setTheme applies immediately and shows in a dirty draft", async () => {
    const store = await loadedStore();
    store.editDraft({ processedRoot: "C:/mine" });

    await store.setTheme("dark");

    expect(store.config.theme).toBe("dark");
    expect(store.draft.theme).toBe("dark");
    expect(store.draft.processedRoot).toBe("C:/mine");
  });

  it("updateToken normalises, persists, and rebuilds the client", async () => {
    const store = await loadedStore();
    calls.configureApiClient = [];

    await store.updateToken(`  "${JWT2}"  `);

    expect(calls.setApiToken).toEqual([JWT2]);
    expect(store.apiToken).toBe(JWT2);
    expect(store.draftToken).toBeNull();
    expect(calls.configureApiClient).toHaveLength(1);
  });
});

describe("browseForRoot", () => {
  it("puts the chosen folder in the draft only", async () => {
    const store = await loadedStore();
    state.picked = "D:/new-scans";

    const path = await store.browseForRoot("unprocessedRoot");

    expect(path).toBe("D:/new-scans");
    expect(store.draft.unprocessedRoot).toBe("D:/new-scans");
    expect(store.config.unprocessedRoot).toBe("C:/scans");
    expect(store.dirty).toBe(true);
  });

  it("leaves the draft alone when the picker is cancelled", async () => {
    const store = await loadedStore();
    state.picked = null;

    await expect(store.browseForRoot("processedRoot")).resolves.toBeNull();
    expect(store.draft.processedRoot).toBe("C:/done");
    expect(store.dirty).toBe(false);
  });
});
