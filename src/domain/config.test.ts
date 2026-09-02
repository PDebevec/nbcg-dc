import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  isConfigured,
  describeRootValidity,
  isRootUsable,
  normalizeBaseUrl,
  validateBaseUrl,
  normalizeApiPrefix,
  validateApiPrefix,
  validateKeycloakUrl,
  normalizeUsername,
  validateCredentials,
  maskSecret,
  summarizePassword,
  validateConfig,
  normalizeConfig,
} from "./config";

describe("isConfigured", () => {
  it("needs both roots and a base URL", () => {
    expect(isConfigured(DEFAULT_CONFIG)).toBe(false);
    expect(
      isConfigured({ ...DEFAULT_CONFIG, unprocessedRoot: "C:/scans" }),
    ).toBe(false);
    expect(
      isConfigured({
        ...DEFAULT_CONFIG,
        unprocessedRoot: "C:/scans",
        processedRoot: "C:/done",
      }),
    ).toBe(true);
  });
});

describe("root validity", () => {
  it("labels each validity", () => {
    expect(describeRootValidity("valid")).toBe("Valid");
    expect(describeRootValidity("not-set")).toBe("Not set");
    expect(describeRootValidity("invalid")).toBe("Invalid path");
    expect(describeRootValidity("unknown")).toBe("Not checked");
  });

  it("treats only a known-broken or unset root as unusable", () => {
    expect(isRootUsable("valid")).toBe(true);
    // No filesystem to ask (dev outside Tauri) must not block the operator.
    expect(isRootUsable("unknown")).toBe(true);
    expect(isRootUsable("invalid")).toBe(false);
    expect(isRootUsable("not-set")).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeBaseUrl("  https://api.nbcg.me/  ")).toBe(
      "https://api.nbcg.me",
    );
    expect(normalizeBaseUrl("http://localhost:3000///")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeBaseUrl("")).toBe("");
  });
});

describe("validateBaseUrl", () => {
  it("accepts the documented hosts", () => {
    expect(validateBaseUrl("https://api.nbcg.me")).toBeNull();
    expect(validateBaseUrl("http://localhost:3000")).toBeNull();
    expect(validateBaseUrl("http://172.21.221.80:3000")).toBeNull();
    // A trailing slash is normalised away, not rejected.
    expect(validateBaseUrl("http://localhost:3000/")).toBeNull();
  });

  it("requires a value", () => {
    expect(validateBaseUrl("")).toMatch(/Enter the backend base URL/);
    expect(validateBaseUrl("   ")).toMatch(/Enter the backend base URL/);
  });

  it("requires a scheme and rejects non-http(s)", () => {
    expect(validateBaseUrl("api.nbcg.me")).toMatch(/include the scheme/i);
    expect(validateBaseUrl("ftp://api.nbcg.me")).toMatch(/http:\/\/ or https:\/\//);
    expect(validateBaseUrl("file:///c:/tmp")).toMatch(/http:\/\/ or https:\/\//);
  });

  it("rejects a query string or fragment", () => {
    expect(validateBaseUrl("https://api.nbcg.me?x=1")).toMatch(/query string/);
    expect(validateBaseUrl("https://api.nbcg.me#frag")).toMatch(/fragment/);
  });

  it("catches the /api suffix that would produce /api/api/…", () => {
    // Verified against the running backend: /api/health is 200, /health is 404 —
    // so a doubled prefix looks like an outage rather than a config mistake.
    expect(validateBaseUrl("http://localhost:3000/api")).toMatch(/Leave off the \/api/);
    expect(validateBaseUrl("http://localhost:3000/api/")).toMatch(/Leave off the \/api/);
    expect(validateBaseUrl("http://localhost:3000/API")).toMatch(/Leave off the \/api/);
  });
});

describe("api prefix", () => {
  it("normalises to a leading, non-trailing slash", () => {
    expect(normalizeApiPrefix("api")).toBe("/api");
    expect(normalizeApiPrefix("/api/")).toBe("/api");
    expect(normalizeApiPrefix("  /api  ")).toBe("/api");
    expect(normalizeApiPrefix("")).toBe("");
    expect(normalizeApiPrefix("/")).toBe("");
  });

  it("accepts empty (API served at the root) and URL-safe paths", () => {
    expect(validateApiPrefix("")).toBeNull();
    expect(validateApiPrefix("/api")).toBeNull();
    expect(validateApiPrefix("/api/v2")).toBeNull();
  });

  it("rejects unsafe path characters", () => {
    expect(validateApiPrefix("/api path")).toMatch(/URL-safe/);
    expect(validateApiPrefix("/api?x")).toMatch(/URL-safe/);
  });
});

describe("validateKeycloakUrl", () => {
  it("accepts a dev and a prod-shaped host", () => {
    expect(validateKeycloakUrl("http://localhost:8082")).toBeNull();
    expect(validateKeycloakUrl("https://auth.nbcg.me")).toBeNull();
  });

  it("requires a value and a scheme", () => {
    expect(validateKeycloakUrl("")).toMatch(/Enter the Keycloak host/);
    expect(validateKeycloakUrl("localhost")).toMatch(/include the scheme/i);
  });

  it("rejects a query string or fragment", () => {
    expect(validateKeycloakUrl("http://localhost:8082?x=1")).toMatch(/query string/);
  });
});

describe("normalizeUsername", () => {
  it("trims whitespace", () => {
    expect(normalizeUsername("  alice  ")).toBe("alice");
  });
});

describe("validateCredentials", () => {
  it("is fine with both filled in, or both blank", () => {
    expect(validateCredentials("alice", "secret")).toBeNull();
    expect(validateCredentials("", "")).toBeNull();
  });

  it("flags exactly one of the two being filled in", () => {
    expect(validateCredentials("alice", "")).toMatch(/Enter both/);
    expect(validateCredentials("", "secret")).toMatch(/Enter both/);
  });
});

describe("maskSecret / summarizePassword", () => {
  it("reveals no characters of the secret", () => {
    const masked = maskSecret("hunter2");
    expect(masked).toMatch(/^•+$/);
    expect(masked).not.toContain("hunter");
  });

  it("caps the mask so it does not leak the length", () => {
    expect(maskSecret("a".repeat(500)).length).toBe(24);
    expect(maskSecret("abc").length).toBe(3);
  });

  it("renders nothing for an absent password", () => {
    expect(maskSecret(null)).toBe("");
    expect(maskSecret(undefined)).toBe("");
    expect(maskSecret("")).toBe("");
  });

  it("summarises presence without exposing the password", () => {
    expect(summarizePassword("hunter2")).toEqual({
      present: true,
      masked: maskSecret("hunter2"),
    });
    expect(summarizePassword(null)).toEqual({ present: false, masked: "" });
  });
});

describe("validateConfig", () => {
  const base = {
    backendBaseUrl: "https://api.nbcg.me",
    apiPrefix: "/api",
    keycloakUrl: "http://localhost:8082",
    kcUsername: "",
  };

  it("is valid with a good URL and no credentials", () => {
    const result = validateConfig(base, null);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.warnings).toEqual({});
  });

  it("reports a bad backend URL as a blocking error", () => {
    const result = validateConfig({ ...base, backendBaseUrl: "nope" }, "secret");
    expect(result.valid).toBe(false);
    expect(result.errors.backendBaseUrl).toBeTruthy();
  });

  it("reports a bad Keycloak URL as a blocking error", () => {
    const result = validateConfig({ ...base, keycloakUrl: "nope" }, null);
    expect(result.valid).toBe(false);
    expect(result.errors.keycloakUrl).toBeTruthy();
  });

  it("reports a half-filled-in username/password as a non-blocking warning", () => {
    const result = validateConfig({ ...base, kcUsername: "alice" }, "");
    expect(result.valid).toBe(true);
    expect(result.warnings.kcPassword).toBeTruthy();
  });

  it("reports a bad prefix", () => {
    const result = validateConfig({ ...base, apiPrefix: "/a b" }, null);
    expect(result.valid).toBe(false);
    expect(result.errors.apiPrefix).toBeTruthy();
  });
});

describe("normalizeConfig", () => {
  it("canonicalises the URL fields and leaves the rest untouched", () => {
    const result = normalizeConfig({
      ...DEFAULT_CONFIG,
      backendBaseUrl: "  http://localhost:3000/  ",
      apiPrefix: "api/",
      unprocessedRoot: "C:/scans",
    });
    expect(result.backendBaseUrl).toBe("http://localhost:3000");
    expect(result.apiPrefix).toBe("/api");
    expect(result.unprocessedRoot).toBe("C:/scans");
    expect(result.theme).toBe(DEFAULT_CONFIG.theme);
  });
});
