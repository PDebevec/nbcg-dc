/**
 * Minimal leveled logger. A thin, swappable wrapper over `console` so call
 * sites read consistently (`logger.warn("config", …)`) and a future sink (file
 * log, native forwarding) can be added in one place.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Verbose in dev, quieter in a production bundle.
let minLevel: LogLevel = import.meta.env.DEV ? "debug" : "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  args: unknown[],
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const prefix = `[${scope}]`;
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;
  sink(prefix, message, ...args);
}

export const logger = {
  debug: (scope: string, message: string, ...args: unknown[]) =>
    emit("debug", scope, message, args),
  info: (scope: string, message: string, ...args: unknown[]) =>
    emit("info", scope, message, args),
  warn: (scope: string, message: string, ...args: unknown[]) =>
    emit("warn", scope, message, args),
  error: (scope: string, message: string, ...args: unknown[]) =>
    emit("error", scope, message, args),
};
