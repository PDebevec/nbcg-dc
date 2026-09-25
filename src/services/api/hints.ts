/**
 * Typeahead for the v2 metadata editor. The schema says where to ask: a field's
 * `suggest.path` (free hints from existing data, `GET /api/search/suggest`) or
 * a big vocabulary's `search.path` (`GET /api/search/vocabularies/:name`). Both
 * answer `{ suggestions: [{ value, count? }] }`. The path carries its own query
 * (`?field=publisher&limit=5`); the typed text is one more parameter.
 */

import type { ApiClient } from "./client";
import { getApiClient } from "../backend";

/** One hint: a string, a `{ code, en, cnr }`, or an author object. */
export interface Hint {
  value: unknown;
  count?: number;
}

interface HintResponse {
  suggestions?: Hint[];
}

/** `/search/suggest?field=publisher&limit=5` → the path and its query. */
export function splitSchemaPath(path: string): { path: string; query: Record<string, string> } {
  const at = path.indexOf("?");
  if (at === -1) return { path, query: {} };
  const query: Record<string, string> = {};
  new URLSearchParams(path.slice(at + 1)).forEach((value, key) => {
    query[key] = value;
  });
  return { path: path.slice(0, at), query };
}

/** Ask for hints for `text`. */
export async function fetchHints(
  path: string,
  queryParam: string,
  text: string,
  options: { client?: ApiClient; signal?: AbortSignal } = {},
): Promise<Hint[]> {
  const client = options.client ?? getApiClient();
  const split = splitSchemaPath(path);
  const res = await client.get<HintResponse>(split.path, {
    query: { ...split.query, [queryParam]: text },
    signal: options.signal,
  });
  return Array.isArray(res?.suggestions) ? res.suggestions : [];
}
