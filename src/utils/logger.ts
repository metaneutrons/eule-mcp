type Level = "debug" | "info" | "warn" | "error";

let output: "stderr" | "stdout" = "stdout";

export function setLogOutput(mode: "stderr" | "stdout"): void {
  output = mode;
}

function log(level: Level, ...args: unknown[]): void {
  const fn = output === "stderr" ? console.error : console.log;  
  fn(`[${level}]`, ...args);
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
