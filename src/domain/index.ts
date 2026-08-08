/**
 * Domain barrel — framework-free types & rules shared across every lane.
 *
 * Nothing here imports from `services/`, `ipc/`, `stores/`, or any framework.
 * Presentation may import these types; the application layer builds on them.
 */

export * from "./enums";
export * from "./schema";
export * from "./metadata";
export * from "./metadata-form";
export * from "./config";
export * from "./connection";
export * from "./naming";
export * from "./files";
export * from "./item";
export * from "./overview";
export * from "./batch";
export * from "./parent";
export * from "./provenance";
export * from "./sync";
