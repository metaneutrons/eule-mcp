import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

function capturedVersion(path, pattern) {
  const match = readFileSync(path, "utf8").match(pattern);
  if (!match?.[1]) throw new Error(`Could not read the Eule version from ${path}`);
  return match[1];
}

const versions = new Map([
  ["package.json", packageVersion],
  ["helper/Cargo.toml", capturedVersion("helper/Cargo.toml", /^version = "([^"]+)"/m)],
  [
    "helper/Cargo.lock",
    capturedVersion("helper/Cargo.lock", /name = "eule-helper"\nversion = "([^"]+)"/),
  ],
  [
    ".release-please-manifest.json",
    JSON.parse(readFileSync(".release-please-manifest.json", "utf8"))["."],
  ],
]);

if ([...versions.values()].some((version) => version !== packageVersion)) {
  const details = [...versions].map(([path, version]) => `${path}: ${version}`).join("\n");
  throw new Error(`Eule versions are inconsistent:\n${details}`);
}

console.log(`Eule version ${packageVersion} is consistent across release metadata.`);
