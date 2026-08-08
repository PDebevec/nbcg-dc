/**
 * nbcg REST client barrel (Seam 3). One module per resource; `dto` holds the
 * wire types. Every resource the archive uses is now covered: `health`
 * (reachability), `schema`, `cobiss`, `search` (+ the `collections` parent-picker
 * projection built on it), `relations`, `items`, and `files`.
 */
export * from "./client";
export * from "./health";
export * from "./schema";
export * from "./cobiss";
export * from "./search";
export * from "./collections";
export * from "./relations";
export * from "./items";
export * from "./files";
export * from "./dto";
