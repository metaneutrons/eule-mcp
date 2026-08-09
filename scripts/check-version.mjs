import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const releaseConfig = JSON.parse(readFileSync("release-please-config.json", "utf8"));

function capturedVersion(path, pattern) {
  const match = readFileSync(path, "utf8").match(pattern);
  if (!match?.[1]) throw new Error(`Could not read the Eule version from ${path}`);
  return match[1];
}

const versions = new Map([
  ["package.json", packageVersion],
  [
    "helper/Cargo.toml",
    capturedVersion(
      "helper/Cargo.toml",
      /^version = "([^"]+)" # x-release-please-version$/m,
    ),
  ],
  [
    "helper/Cargo.lock",
    capturedVersion(
      "helper/Cargo.lock",
      /name = "eule-helper"\nversion = "([^"]+)" # x-release-please-version/,
    ),
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

if (releaseConfig["include-component-in-tag"] !== false) {
  throw new Error(
    "release-please-config.json must set include-component-in-tag=false so helper downloads and release tags both use v<version>",
  );
}

if (releaseConfig["include-v-in-tag"] !== true) {
  throw new Error("release-please-config.json must set include-v-in-tag=true");
}

console.log(`Eule version ${packageVersion} is consistent across release metadata.`);
