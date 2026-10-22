// MCPB is a ZIP with a schema-validated manifest at its root. Keep the build
// surface limited to that format, rather than importing an interactive/signing CLI.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { zipSync } from "fflate";
import ignore from "ignore";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const schema = JSON.parse(
  readFileSync(new URL("../vendor/mcpb/manifest-v0.3.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// Preserve the upstream packer's default exclusions, plus the staged .mcpbignore.
// Provenance/license for the upstream format and patterns: ../vendor/mcpb/README.md.
const EXCLUDE = [
  ".DS_Store",
  "Thumbs.db",
  ".gitignore",
  ".git",
  ".mcpbignore",
  "*.log",
  ".env*",
  ".npm",
  ".npmrc",
  ".yarnrc",
  ".yarn",
  ".eslintrc",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  ".eslintignore",
  ".nycrc",
  ".babelrc",
  ".pnp.*",
  "node_modules/.cache",
  "node_modules/.bin",
  "*.map",
  "npm-debug.log*",
  "yarn-debug.log*",
  "yarn-error.log*",
  "package-lock.json",
  "yarn.lock",
  "*.mcpb",
  "*.d.ts",
  "*.tsbuildinfo",
  "tsconfig.json",
];

/** Pack a controlled staging directory; never follow symlinks or prompt interactively. */
export function packMcpb(directory, outputPath) {
  const root = realpathSync(directory);
  const output = resolve(outputPath);
  // Resolve the existing parent too, so a symlink alias cannot put output inside input.
  const actualOutput = join(realpathSync(dirname(output)), basename(output));
  const outputRelative = relative(root, actualOutput);
  if (
    !isAbsolute(outputRelative) &&
    outputRelative !== ".." &&
    !outputRelative.startsWith(`..${sep}`)
  ) {
    throw new Error("MCPB output must be outside the input directory");
  }
  if (lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("MCPB output must not be a symlink");
  }
  const manifestPath = join(root, "manifest.json");
  if (lstatSync(manifestPath).isSymbolicLink())
    throw new Error("MCPB symlinks are not allowed: manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== "0.3" || !validate(manifest)) {
    throw new Error(`Invalid MCPB manifest: ${ajv.errorsText(validate.errors)}`);
  }
  const ignorePath = join(root, ".mcpbignore");
  if (lstatSync(ignorePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("MCPB symlinks are not allowed: .mcpbignore");
  }
  const excluded = ignore().add(EXCLUDE);
  if (existsSync(ignorePath)) excluded.add(readFileSync(ignorePath, "utf8"));
  const files = Object.create(null);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const fullPath = join(dir, name);
      const zipPath = relative(root, fullPath).split(sep).join("/");
      const stat = lstatSync(fullPath);
      if (excluded.ignores(zipPath + (stat.isDirectory() ? "/" : ""))) continue;
      if (stat.isSymbolicLink()) throw new Error(`MCPB symlinks are not allowed: ${zipPath}`);
      if (zipPath.includes("\\")) throw new Error(`Non-portable MCPB path: ${zipPath}`);
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) {
        files[zipPath] = [readFileSync(fullPath), { os: 3, attrs: (stat.mode & 0o777) << 16 }];
      } else throw new Error(`Unsupported MCPB file type: ${zipPath}`);
    }
  };
  walk(root);
  const iconFiles = [
    ...(manifest.icon !== undefined ? [manifest.icon] : []),
    ...(manifest.icons ?? []).map((icon) => icon.src),
  ];
  const requiredFiles = ["manifest.json", manifest.server.entry_point, ...iconFiles];
  for (const required of requiredFiles) {
    if (!Object.hasOwn(files, required))
      throw new Error(`Required MCPB file missing or excluded: ${required}`);
  }
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const icon of iconFiles) {
    if (!files[icon][0].subarray(0, png.length).equals(png)) {
      throw new Error(`MCPB icon must be a PNG file: ${icon}`);
    }
  }
  // Stable order and timestamp make identical staging trees produce identical bytes.
  // ZIP stores local wall-clock fields; construct them locally so all timezones
  // encode the same 1980 timestamp (UTC midnight would become 1979 in the Americas).
  writeFileSync(output, zipSync(files, { level: 9, mtime: new Date(1980, 0, 1) }));
}
