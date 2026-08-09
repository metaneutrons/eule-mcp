import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  name?: string;
  version?: string;
}

/** Product version from package.json, Eule's single source of truth. */
function readProductVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const metadata = JSON.parse(readFileSync(path, "utf8")) as PackageMetadata;
      if (metadata.name === "eule-mcp" && metadata.version) return metadata.version;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error("Could not determine the Eule version from package.json.");
}

export const EULE_VERSION = readProductVersion();
