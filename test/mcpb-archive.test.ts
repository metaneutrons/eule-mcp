import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import { packMcpb } from "../scripts/lib/mcpb-archive.mjs";

const ENTRY_PATH = "dist/server/index.js";
const ICON_PATH = "assets/icon.png";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A tiny, valid 1x1 PNG; the packer's icon check only needs its PNG header.
const ICON_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0V8AAAAASUVORK5CYII=",
  "base64",
);

// Mirrors the shape of this repository's manifest.json while keeping every
// fixture self-contained and synthetic.
const VALID_MANIFEST = {
  manifest_version: "0.3",
  name: "fixture-extension",
  display_name: "Fixture Extension",
  version: "1.2.3",
  description: "Synthetic MCPB archive fixture.",
  long_description: "A synthetic fixture for archive regression tests.",
  author: { name: "Fixture Author", url: "https://example.test/author" },
  repository: { type: "git", url: "https://example.test/fixture.git" },
  homepage: "https://example.test/fixture",
  documentation: "https://example.test/fixture/docs",
  support: "https://example.test/fixture/issues",
  icon: ICON_PATH,
  license: "MIT",
  keywords: ["mcp", "fixture"],
  server: {
    type: "node",
    entry_point: ENTRY_PATH,
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/server/index.js"],
    },
  },
  tools_generated: true,
  compatibility: {
    platforms: ["darwin", "linux", "win32"],
    runtimes: { node: ">=24" },
  },
};

interface Fixture {
  inputDir: string;
  tempRoot: string;
}

function writePath(root: string, relativePath: string, contents: string | Buffer): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeManifest(root: string, manifest: unknown): void {
  writePath(root, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

function createFixture(root: string, manifest: unknown = VALID_MANIFEST): void {
  writeManifest(root, manifest);
  writePath(root, ENTRY_PATH, "// synthetic production entry point\n");
  writePath(root, ICON_PATH, ICON_BYTES);
  writePath(root, "README.md", "Synthetic archive fixture.\n");
}

function withFixture(run: (fixture: Fixture) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "mcpb-archive-test-"));
  try {
    const inputDir = join(tempRoot, "input");
    mkdirSync(inputDir);
    createFixture(inputDir);
    run({ inputDir, tempRoot });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

interface CentralEntry {
  name: string;
  platform: number;
  mode: number | null;
}

/** Read just the central-directory fields needed for path and Unix-mode checks. */
function readCentralDirectory(archive: Buffer): CentralEntry[] {
  let endOffset = -1;
  const minOffset = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory record not found");

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const entries: CentralEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid ZIP central-directory entry");
    const platform = archive.readUInt16LE(offset + 4) >>> 8;
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({
      name,
      platform,
      mode: platform === 3 ? (externalAttributes >>> 16) & 0xffff : null,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("packMcpb", () => {
  it.each([
    { ...VALID_MANIFEST, server: { ...VALID_MANIFEST.server, entry_point: "" } },
    { ...VALID_MANIFEST, icon: "" },
  ])("rejects empty paths for required or explicitly declared bundle files", (manifest) => {
    withFixture(({ inputDir, tempRoot }) => {
      writeManifest(inputDir, manifest);
      expect(() => packMcpb(inputDir, join(tempRoot, "fixture.mcpb"))).toThrow(
        /missing or excluded/,
      );
    });
  });

  it("produces the same ZIP timestamps across western and eastern timezones", () => {
    withFixture(({ inputDir, tempRoot }) => {
      try {
        vi.stubEnv("TZ", "America/Los_Angeles");
        const west = join(tempRoot, "west.mcpb");
        packMcpb(inputDir, west);
        vi.stubEnv("TZ", "Asia/Tokyo");
        const east = join(tempRoot, "east.mcpb");
        packMcpb(inputDir, east);
        expect(readFileSync(west)).toEqual(readFileSync(east));
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a dangling output symlink without creating its target",
    () => {
      withFixture(({ inputDir, tempRoot }) => {
        const target = join(tempRoot, "must-not-be-created");
        const output = join(tempRoot, "alias.mcpb");
        symlinkSync(target, output);
        expect(() => packMcpb(inputDir, output)).toThrow(/symlink/);
        expect(existsSync(target)).toBe(false);
      });
    },
  );
  it("writes the validated manifest at ZIP root with its production entry and icon", () => {
    withFixture(({ inputDir, tempRoot }) => {
      const outputPath = join(tempRoot, "fixture.mcpb");
      packMcpb(inputDir, outputPath);

      const archive = unzipSync(readFileSync(outputPath));
      expect(Object.keys(archive)).toContain("manifest.json");
      expect(JSON.parse(Buffer.from(archive["manifest.json"]).toString("utf8"))).toEqual(
        VALID_MANIFEST,
      );
      expect(Buffer.from(archive[ENTRY_PATH]).toString("utf8")).toContain(
        "synthetic production entry point",
      );
      expect(Buffer.from(archive[ICON_PATH]).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    });
  });

  it("uses relative, forward-slash ZIP paths", () => {
    withFixture(({ inputDir, tempRoot }) => {
      const outputPath = join(tempRoot, "fixture.mcpb");
      packMcpb(inputDir, outputPath);

      const names = readCentralDirectory(readFileSync(outputPath)).map(({ name }) => name);
      expect(names).toContain("manifest.json");
      expect(names).toContain(ENTRY_PATH);
      expect(names).toContain(ICON_PATH);
      for (const name of names) {
        expect(name).not.toContain("\\");
        expect(name).not.toMatch(/^(?:\/|[A-Za-z]:)/);
        expect(name.split("/")).not.toContain("..");
      }
    });
  });

  it("omits the default secret, VCS, source-map, and cache paths", () => {
    withFixture(({ inputDir, tempRoot }) => {
      const excludedPaths = [
        ".env",
        ".env.production",
        ".git/config",
        "dist/server/index.js.map",
        "node_modules/.cache/data.bin",
        "node_modules/.bin/tool",
      ];
      for (const path of excludedPaths) writePath(inputDir, path, "synthetic secret/cache data");

      const outputPath = join(tempRoot, "fixture.mcpb");
      packMcpb(inputDir, outputPath);

      const names = Object.keys(unzipSync(readFileSync(outputPath)));
      for (const path of excludedPaths) expect(names).not.toContain(path);
    });
  });

  it("applies .mcpbignore exclusions and supports negation", () => {
    withFixture(({ inputDir, tempRoot }) => {
      writePath(
        inputDir,
        ".mcpbignore",
        ["secrets/**", "cache/**", "private/*.txt", "!private/keep.txt", "exclude.log", ""].join(
          "\n",
        ),
      );
      writePath(inputDir, "secrets/oauth.json", "synthetic secret");
      writePath(inputDir, "cache/result.bin", "synthetic cache");
      writePath(inputDir, "private/drop.txt", "excluded by pattern");
      writePath(inputDir, "private/keep.txt", "restored by negation");
      writePath(inputDir, "exclude.log", "excluded by exact path");

      const outputPath = join(tempRoot, "fixture.mcpb");
      packMcpb(inputDir, outputPath);

      const names = Object.keys(unzipSync(readFileSync(outputPath)));
      expect(names).not.toContain("secrets/oauth.json");
      expect(names).not.toContain("cache/result.bin");
      expect(names).not.toContain("private/drop.txt");
      expect(names).not.toContain("exclude.log");
      expect(names).toContain("private/keep.txt");
    });
  });

  it.skipIf(process.platform === "win32")("preserves executable Unix permissions", () => {
    withFixture(({ inputDir, tempRoot }) => {
      chmodSync(join(inputDir, ENTRY_PATH), 0o755);
      const outputPath = join(tempRoot, "fixture.mcpb");
      packMcpb(inputDir, outputPath);

      const entry = readCentralDirectory(readFileSync(outputPath)).find(
        ({ name }) => name === ENTRY_PATH,
      );
      expect(entry?.platform).toBe(3);
      expect(entry?.mode).not.toBeNull();
      expect(entry!.mode! & 0o777 & 0o111).toBe(0o111);
    });
  });

  it("rejects unsupported manifest schema versions", () => {
    withFixture(({ inputDir, tempRoot }) => {
      const manifest = { ...VALID_MANIFEST, manifest_version: "0.4" };
      writeManifest(inputDir, manifest);
      expect(() => packMcpb(inputDir, join(tempRoot, "fixture.mcpb"))).toThrow();
    });
  });

  it("rejects unknown manifest keys", () => {
    withFixture(({ inputDir, tempRoot }) => {
      const manifest = { ...VALID_MANIFEST, unrecognized_setting: true };
      writeManifest(inputDir, manifest);
      expect(() => packMcpb(inputDir, join(tempRoot, "fixture.mcpb"))).toThrow();
    });
  });

  it("rejects manifest fields with invalid types and URI formats", () => {
    withFixture(({ inputDir, tempRoot }) => {
      writeManifest(inputDir, { ...VALID_MANIFEST, version: 123 });
      expect(() => packMcpb(inputDir, join(tempRoot, "wrong-version-type.mcpb"))).toThrow();

      writeManifest(inputDir, {
        ...VALID_MANIFEST,
        author: { name: "Fixture Author", url: "not a URI" },
      });
      expect(() => packMcpb(inputDir, join(tempRoot, "wrong-url-format.mcpb"))).toThrow();
    });
  });

  it("rejects a missing production entry point", () => {
    withFixture(({ inputDir, tempRoot }) => {
      unlinkSync(join(inputDir, ENTRY_PATH));
      expect(() => packMcpb(inputDir, join(tempRoot, "fixture.mcpb"))).toThrow();
    });
  });

  it("rejects a missing or excluded referenced icon", () => {
    withFixture(({ inputDir, tempRoot }) => {
      unlinkSync(join(inputDir, ICON_PATH));
      expect(() => packMcpb(inputDir, join(tempRoot, "missing-icon.mcpb"))).toThrow();
    });

    withFixture(({ inputDir, tempRoot }) => {
      writePath(inputDir, ".mcpbignore", `${ICON_PATH}\n`);
      expect(() => packMcpb(inputDir, join(tempRoot, "excluded-icon.mcpb"))).toThrow();
    });
  });

  it("rejects an entry point excluded by .mcpbignore", () => {
    withFixture(({ inputDir, tempRoot }) => {
      writePath(inputDir, ".mcpbignore", `${ENTRY_PATH}\n`);
      expect(() => packMcpb(inputDir, join(tempRoot, "excluded-entry.mcpb"))).toThrow();
    });
  });

  it("rejects a symlink that could expose a file outside the input tree", (context) => {
    withFixture(({ inputDir, tempRoot }) => {
      const outsideFile = join(tempRoot, "outside-secret.txt");
      writeFileSync(outsideFile, "synthetic external secret");
      try {
        symlinkSync(outsideFile, join(inputDir, "leaked-secret.txt"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) {
          context.skip();
          return;
        }
        throw error;
      }

      expect(() => packMcpb(inputDir, join(tempRoot, "fixture.mcpb"))).toThrow();
    });
  });

  it("rejects an archive output path inside the input directory", () => {
    withFixture(({ inputDir }) => {
      const outputPath = join(inputDir, "fixture.mcpb");
      expect(() => packMcpb(inputDir, outputPath)).toThrow();
      expect(existsSync(outputPath)).toBe(false);
    });
  });

  it("produces byte-identical archives with stable order and metadata", () => {
    withFixture(({ inputDir, tempRoot }) => {
      // Deliberately create entries in a non-sorted order.
      writePath(inputDir, "z-last.txt", "last alphabetically");
      writePath(inputDir, "a-first.txt", "first alphabetically");
      const firstPath = join(tempRoot, "first.mcpb");
      const secondPath = join(tempRoot, "second.mcpb");

      packMcpb(inputDir, firstPath);
      packMcpb(inputDir, secondPath);

      const firstBytes = readFileSync(firstPath);
      const secondBytes = readFileSync(secondPath);
      expect(secondBytes).toEqual(firstBytes);
      const names = readCentralDirectory(firstBytes).map(({ name }) => name);
      expect(names.indexOf("a-first.txt")).toBeLessThan(names.indexOf("z-last.txt"));
    });
  });
});
