/**
 * Locate (and, on first use, download) the platform-native `eule-helper` binary.
 *
 * The helper is a small Rust GUI tool (webview OAuth capture + secret prompt)
 * released per platform×arch as a GitHub release asset. Rather than bundling it
 * in the npm package (which would need per-platform packages) or a postinstall
 * hook (which breaks offline `npm install`), we fetch the matching asset lazily
 * on first use, verify its .sha256, and cache it 0700 under ~/.eule/bin.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "metaneutrons/eule-mcp";

/** GitHub release asset name for the current platform + architecture. */
export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "darwin") return "eule-helper-darwin-universal";
  if (platform === "linux") {
    if (arch === "x64") return "eule-helper-linux-x64";
    if (arch === "arm64") return "eule-helper-linux-arm64";
  }
  if (platform === "win32") {
    if (arch === "x64") return "eule-helper-win32-x64.exe";
    if (arch === "arm64") return "eule-helper-win32-arm64.exe";
  }
  throw new Error(`No eule-helper build for ${platform}/${arch}.`);
}

/** Cached binary location (~/.eule/bin/eule-helper[.exe]). */
export function helperPath(): string {
  const name = process.platform === "win32" ? "eule-helper.exe" : "eule-helper";
  return join(homedir(), ".eule", "bin", name);
}

/** Read this package's version by walking up from the running module to package.json. */
function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "eule-mcp" && pkg.version) return pkg.version;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("Could not determine eule-mcp version for the helper download.");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${String(res.status)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Ensure the helper binary is present and checksum-valid, downloading it if
 * needed. Returns its absolute path. `version` defaults to this package's
 * version (→ tag `v<version>`), overridable for tests.
 */
export async function ensureHelper(version = packageVersion()): Promise<string> {
  const dest = helperPath();
  const asset = assetName();
  const base = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;

  // Fetch the expected checksum first (small); if the cached binary already
  // matches it, skip the (large) binary download entirely.
  const shaText = (await fetchBuffer(`${base}.sha256`)).toString("utf-8").trim();
  const expected = shaText.split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Malformed checksum for ${asset}: ${shaText}`);
  }

  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) return dest;

  const bin = await fetchBuffer(base);
  if (sha256(bin) !== expected) {
    throw new Error(`Checksum mismatch for ${asset} — refusing to install.`);
  }
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeFileSync(dest, bin, { mode: 0o700 });
  chmodSync(dest, 0o700); // mode is honored only on create; enforce on overwrite
  return dest;
}
