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
  normalizeApiToken,
  looksLikeJwt,
  validateApiToken,
  maskToken,
  summarizeToken,
  validateConfig,
  normalizeConfig,
} from "./config";

/** A shape-valid (not real) JWT: three base64url segments. */
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJuYmNnIn0.c2lnbmF0dXJl";

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

describe("normalizeApiToken", () => {
  it("passes a bare token through", () => {
    expect(normalizeApiToken(JWT)).toBe(JWT);
    expect(normalizeApiToken(`  ${JWT}  `)).toBe(JWT);
  });

  it("unwraps the Keycloak JSON envelope the docs' curl prints", () => {
    const envelope = JSON.stringify({
      access_token: JWT,
      expires_in: 300,
      token_type: "Bearer",
    });
    expect(normalizeApiToken(envelope)).toBe(JWT);
  });

  it("leaves a JSON blob without access_token alone (as a literal)", () => {
    expect(normalizeApiToken('{"error":"invalid_grant"}')).toBe(
      '{"error":"invalid_grant"}',
    );
  });

  it("strips surrounding quotes and a Bearer prefix", () => {
    expect(normalizeApiToken(`"${JWT}"`)).toBe(JWT);
    expect(normalizeApiToken(`'${JWT}'`)).toBe(JWT);
    expect(normalizeApiToken(`Bearer ${JWT}`)).toBe(JWT);
    expect(normalizeApiToken(`bearer ${JWT}`)).toBe(JWT);
    expect(normalizeApiToken(`"Bearer ${JWT}"`)).toBe(JWT);
  });

  it("removes whitespace a wrapped paste introduces", () => {
    expect(normalizeApiToken("eyJhbGci\n  OiJSUzI1NiJ9.eyJ.c2ln")).toBe(
      "eyJhbGciOiJSUzI1NiJ9.eyJ.c2ln",
    );
  });

  it("maps blank input to an empty string", () => {
    expect(normalizeApiToken("")).toBe("");
    expect(normalizeApiToken("   \n ")).toBe("");
  });
});

describe("looksLikeJwt / validateApiToken", () => {
  it("recognises three base64url segments", () => {
    expect(looksLikeJwt(JWT)).toBe(true);
    expect(looksLikeJwt("a.b")).toBe(false);
    expect(looksLikeJwt("a.b.c.d")).toBe(false);
    expect(looksLikeJwt("a.b.c!")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
  });

  it("warns but does not error on an odd-looking token", () => {
    expect(validateApiToken(JWT)).toBeNull();
    // Empty is legal — the app never verifies the token itself.
    expect(validateApiToken("")).toBeNull();
    expect(validateApiToken("not-a-jwt")).toMatch(/does not look like/);
  });

  it("validates the normalised form, so a Bearer paste is not flagged", () => {
    expect(validateApiToken(`Bearer ${JWT}`)).toBeNull();
  });
});

describe("maskToken / summarizeToken", () => {
  it("reveals no characters of the secret", () => {
    const masked = maskToken(JWT);
    expect(masked).toMatch(/^•+$/);
    expect(masked).not.toContain("ey");
  });

  it("caps the mask so it does not leak the length", () => {
    expect(maskToken("a".repeat(500)).length).toBe(24);
    expect(maskToken("abc").length).toBe(3);
  });

  it("renders nothing for an absent token", () => {
    expect(maskToken(null)).toBe("");
    expect(maskToken(undefined)).toBe("");
    expect(maskToken("")).toBe("");
  });

  it("summarises presence and shape without exposing the token", () => {
    expect(summarizeToken(JWT)).toEqual({
      present: true,
      masked: maskToken(JWT),
      jwtShaped: true,
    });
    expect(summarizeToken(null)).toEqual({
      present: false,
      masked: "",
      jwtShaped: false,
    });
    expect(summarizeToken("nope").jwtShaped).toBe(false);
  });
});

describe("validateConfig", () => {
  const base = { backendBaseUrl: "https://api.nbcg.me", apiPrefix: "/api" };

  it("is valid with a good URL and no token", () => {
    const result = validateConfig(base, null);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.warnings).toEqual({});
  });

  it("reports a bad URL as a blocking error", () => {
    const result = validateConfig({ ...base, backendBaseUrl: "nope" }, JWT);
    expect(result.valid).toBe(false);
    expect(result.errors.backendBaseUrl).toBeTruthy();
  });

  it("reports an odd token as a non-blocking warning", () => {
    const result = validateConfig(base, "garbage");
    expect(result.valid).toBe(true);
    expect(result.warnings.apiToken).toBeTruthy();
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
