/**
 * Base REST client for the `nbcg` backend (Seam 3 — Application ↔ Backend).
 *
 * Every backend call goes through here. Responsibilities:
 *  - join `<baseUrl><apiPrefix><path>` (the backend sets a global `/api` prefix);
 *  - attach `Authorization: Bearer <token>` (the static Keycloak token);
 *  - JSON, multipart (`FormData`), and binary responses;
 *  - map HTTP + network failures to a typed {@link ApiError}.
 *
 * HTTP goes over `@tauri-apps/plugin-http` (decision in docs/04) — this keeps
 * every backend concern in TypeScript, out of the Rust core, and dodges webview
 * CORS. `fetchImpl` is injectable so the client is unit-testable without Tauri.
 *
 * NOTE (Arch handoff): the Rust `tauri-plugin-http` must be registered and the
 * capability granted `http:default` with the backend host allow-listed, or the
 * plugin `fetch` will be denied at runtime.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Coarse failure category, derived from the HTTP status (or the transport). */
export type ApiErrorKind =
  | "network"
  | "timeout"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server"
  | "unknown";

/** The Nest error envelope (`{ statusCode, message, error }`). */
interface NestErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status, or 0 for transport-level (network/timeout) failures. */
  readonly status: number;
  readonly url: string;
  readonly method: HttpMethod;
  /** Parsed response body, when one was returned. */
  readonly body: unknown;

  constructor(init: {
    kind: ApiErrorKind;
    status: number;
    url: string;
    method: HttpMethod;
    message: string;
    body?: unknown;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.url = init.url;
    this.method = init.method;
    this.body = init.body;
  }

  /** True for transport failures (host unreachable / timed out) — drives the
   * "Offline" footer state, distinct from a rejected token. */
  get isNetworkError(): boolean {
    return this.kind === "network" || this.kind === "timeout";
  }
}

export type ResponseType = "json" | "text" | "blob" | "void";

export interface RequestOptions {
  /** Query params. `undefined`/`null` are omitted; others are stringified. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body (sets `Content-Type: application/json`). */
  json?: unknown;
  /** Multipart body — pass a `FormData`; the runtime sets the boundary. */
  form?: FormData;
  headers?: Record<string, string>;
  /** External abort signal, combined with the client timeout. */
  signal?: AbortSignal;
  /** How to decode the response. Defaults to `"json"`. */
  responseType?: ResponseType;
  /**
   * Override the client-wide timeout for this one request.
   *
   * Needed because the default is tuned for the backend's own latency, while a
   * few endpoints wait on a *third party* and are legitimately slower than any
   * sane default — `GET /api/import/cobiss/preview/:id` blocks on a 30 s upstream
   * fetch to `ws.cobiss.net`. Timing out below the backend's own budget turns a
   * slow-but-working dependency into a bogus "backend unreachable".
   */
  timeoutMs?: number;
}

/** {@link RequestOptions} plus the knobs {@link ApiClient.requestDetailed} adds. */
export interface DetailedRequestOptions extends RequestOptions {
  /**
   * Non-2xx statuses to treat as success rather than throwing — e.g. `[304]` for
   * an `If-None-Match` conditional GET, so the caller can serve its cache.
   */
  acceptStatuses?: number[];
}

/** A response with its metadata, returned by {@link ApiClient.requestDetailed}. */
export interface DetailedResponse<T> {
  status: number;
  /** Decoded body, or `undefined` for bodiless statuses (204/304) and `void`. */
  data: T | undefined;
  headers: Headers;
  /** The `ETag` response header, if present (drives conditional caching). */
  etag: string | null;
}

export interface ApiClientOptions {
  /** Backend host, e.g. `https://api.nbcg.me`. */
  baseUrl: string;
  /** Global API prefix, e.g. `/api`. */
  apiPrefix: string;
  /** Supplies the current bearer token (read lazily, so token changes apply
   * without rebuilding the client). Return `null` to send no auth header. */
  getToken?: () => string | null;
  /** Override the transport (default: `@tauri-apps/plugin-http` fetch). */
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function ensureLeadingSlash(s: string): string {
  if (s === "") return "";
  return s.startsWith("/") ? s : `/${s}`;
}

function kindFromStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    default:
      if (status >= 500) return "server";
      return "unknown";
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const m = (body as NestErrorBody).message;
    if (Array.isArray(m)) return m.join("; ");
    if (typeof m === "string") return m;
  }
  return fallback;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.apiPrefix = trimTrailingSlash(ensureLeadingSlash(options.apiPrefix));
    this.getToken = options.getToken ?? (() => null);
    this.fetchImpl = options.fetchImpl ?? (tauriFetch as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Absolute URL for an API path (path is relative to the `/api` prefix). */
  buildUrl(
    path: string,
    query?: RequestOptions["query"],
  ): string {
    const url = `${this.baseUrl}${this.apiPrefix}${ensureLeadingSlash(path)}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /**
   * Core transport: build headers/body, apply the timeout + external abort, and
   * return the raw {@link Response}. Throws a transport {@link ApiError}
   * (`network`/`timeout`) on a failed fetch; HTTP status handling is left to the
   * callers ({@link request} / {@link requestDetailed}).
   */
  private async send(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let bodyInit: BodyInit | undefined;
    if (options.form) {
      bodyInit = options.form; // runtime sets the multipart Content-Type
    } else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(options.json);
    }

    // Timeout via an AbortController, combined with any caller-supplied signal.
    // `timedOut` distinguishes our timeout from a caller-driven abort so they
    // are not both reported as "timeout".
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onExternalAbort);
    }

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
    } catch (err) {
      const abortedByCaller = !timedOut && controller.signal.aborted;
      throw new ApiError({
        kind: timedOut ? "timeout" : "network",
        status: 0,
        url,
        method,
        message: timedOut
          ? `Request timed out after ${timeoutMs}ms`
          : abortedByCaller
            ? `Request to ${url} was cancelled`
            : `Network error contacting ${url}: ${(err as Error)?.message ?? err}`,
      });
    } finally {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /** Build the typed {@link ApiError} for a non-accepted HTTP response. */
  private async errorFor(
    response: Response,
    url: string,
    method: HttpMethod,
  ): Promise<ApiError> {
    const body = await this.safeParse(response);
    return new ApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      url,
      method,
      message: messageFromBody(
        body,
        `${method} ${url} failed with ${response.status}`,
      ),
      body,
    });
  }

  /** Decode a successful response body per {@link ResponseType}. */
  private async decode<T>(
    response: Response,
    responseType: ResponseType,
  ): Promise<T> {
    switch (responseType) {
      case "void":
        return undefined as T;
      case "text":
        return (await response.text()) as T;
      case "blob":
        return (await response.blob()) as T;
      case "json": {
        // 204 / empty bodies (transition, delete) decode to undefined.
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
    }
  }

  /**
   * Make a request and decode the body, throwing {@link ApiError} on any non-2xx
   * status. The workhorse for the resource services.
   */
  async request<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const response = await this.send(method, url, options);
    if (!response.ok) throw await this.errorFor(response, url, method);
    return this.decode<T>(response, options.responseType ?? "json");
  }

  /**
   * Like {@link request} but returns the status, headers, and decoded body — for
   * callers that need response metadata (ETag / conditional caching). Pass
   * `acceptStatuses` to treat specific non-2xx statuses as success (e.g. `304`
   * on an `If-None-Match` revalidation); any other non-2xx still throws. A body
   * is decoded only for statuses that carry one (never 204/304).
   */
  async requestDetailed<T>(
    method: HttpMethod,
    path: string,
    options: DetailedRequestOptions = {},
  ): Promise<DetailedResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const response = await this.send(method, url, options);
    const accepted =
      response.ok ||
      (options.acceptStatuses?.includes(response.status) ?? false);
    if (!accepted) throw await this.errorFor(response, url, method);

    const noBody = response.status === 204 || response.status === 304;
    const data = noBody
      ? undefined
      : await this.decode<T>(response, options.responseType ?? "json");
    return {
      status: response.status,
      data,
      headers: response.headers,
      etag: response.headers.get("etag"),
    };
  }

  private async safeParse(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return undefined;
    }
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }
  /** GET returning response metadata (status/headers/ETag) — see
   * {@link requestDetailed}. */
  getDetailed<T>(
    path: string,
    options?: DetailedRequestOptions,
  ): Promise<DetailedResponse<T>> {
    return this.requestDetailed<T>("GET", path, options);
  }
  post<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, options);
  }
  patch<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }
  put<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, options);
  }
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }
}
