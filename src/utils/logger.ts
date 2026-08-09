type Level = "debug" | "info" | "warn" | "error";

let output: "stderr" | "stdout" = "stdout";

export function setLogOutput(mode: "stderr" | "stdout"): void {
  output = mode;
}

function formatArg(arg: unknown): unknown {
  if (arg instanceof Error) return arg.name || "Error";
  if (Array.isArray(arg)) return arg.map((entry) => formatArg(entry));
  if (arg && typeof arg === "object") return "[object redacted]";
  return arg;
}

function log(level: Level, ...args: unknown[]): void {
  const fn = output === "stderr" ? console.error : console.log;
  fn(`[${level}]`, ...args.map((arg) => formatArg(arg)));
}

export const logger = {
  debug: (...args: unknown[]): void => {
    log("debug", ...args);
  },
  info: (...args: unknown[]): void => {
    log("info", ...args);
  },
  warn: (...args: unknown[]): void => {
    log("warn", ...args);
  },
  error: (...args: unknown[]): void => {
    log("error", ...args);
  },
};
