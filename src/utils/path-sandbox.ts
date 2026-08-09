import { lstatSync, realpathSync } from "node:fs";
import { resolve, basename, dirname, relative, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface SecurePathResult {
  dir: string;
  dest: string;
}

const EULE_DIR = join(homedir(), ".eule");
const SAVE_ROOTS_DISPLAY =
  "~/.eule subdirectories, ~/Downloads, ~/Documents, ~/Desktop, or the platform temporary directory (/tmp on POSIX; %TEMP% on Windows)";

/** Shared MCP schema guidance for every tool that writes a downloaded file. */
export const SAVE_PATH_HINT =
  `Optional local save directory. Allowed roots: ${SAVE_ROOTS_DISPLAY}. ` +
  "Omit this field to use Eule's private attachment directory.";

/**
 * Resolves symlinks in the deepest existing ancestor and appends any missing
 * path segments. This normalizes macOS' /tmp -> /private/tmp alias, Windows
 * path casing, and prevents an existing symlink below an allowed directory
 * from escaping the sandbox.
 */
function canonicalize(inputPath: string): string {
  const absolute = resolve(inputPath);
  let existing = absolute;
  const missing: string[] = [];

  while (!pathEntryExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missing.unshift(basename(existing));
    existing = parent;
  }

  try {
    return resolve(realpathSync.native(existing), ...missing);
  } catch {
    throw new Error("Access denied: Save path contains an unresolved symbolic link.");
  }
}

function pathEntryExists(inputPath: string): boolean {
  try {
    lstatSync(inputPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Expands a leading `~` and returns a canonical absolute path. */
function expandAndResolve(inputPath: string): string {
  const expanded = inputPath.startsWith("~") ? join(homedir(), inputPath.slice(1)) : inputPath;
  return canonicalize(expanded);
}

/** True if `target` is `base` or a descendant of it. */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validates and resolves a user-supplied save path and filename.
 * Restricts saving to safe base directories (~/.eule, ~/Downloads, ~/Documents, ~/Desktop,
 * and the OS temporary directory).
 * Sanitizes the filename using path.basename to prevent directory traversal and refuses
 * writes directly into the ~/.eule root.
 *
 * @param userInputPath Custom directory path supplied by the user/LLM (optional).
 * @param filename File name for saving.
 * @param defaultSubdir Default folder under ~/.eule if no custom path is provided.
 */
export function securePath(
  userInputPath: string | undefined,
  filename: string,
  defaultSubdir: string,
): SecurePathResult {
  const home = homedir();
  const allowedBases = [
    EULE_DIR,
    join(home, "Downloads"),
    join(home, "Documents"),
    join(home, "Desktop"),
    tmpdir(),
    ...(process.platform === "win32" ? [] : ["/tmp"]),
  ].map(canonicalize);

  // 1. Sanitize the filename to prevent any path traversal (e.g. "foo/../../bar.txt" -> "bar.txt")
  const safeFilename = basename(filename);
  if (!safeFilename || safeFilename === "." || safeFilename === "..") {
    throw new Error("Invalid filename");
  }

  // 2. Determine target directory
  const targetDir = userInputPath ? expandAndResolve(userInputPath) : join(EULE_DIR, defaultSubdir);

  // 3. Refuse the ~/.eule root itself as a write target — that is where the
  //    secret files (config.yaml, tokens.json, eule.db) live. Downloads must
  //    land in a subdirectory such as ~/.eule/attachments, so a provider- or
  //    caller-supplied filename can never overwrite a secret. (A file merely
  //    NAMED like a secret but saved to a subdir/Downloads is harmless.)
  if (targetDir === canonicalize(EULE_DIR)) {
    throw new Error("Access denied: cannot write into the ~/.eule root; use a subdirectory.");
  }

  // 4. Ensure the target directory is within an allowed base directory.
  if (!allowedBases.some((base) => isWithin(base, targetDir))) {
    throw new Error(`Access denied: Save directory must be within ${SAVE_ROOTS_DISPLAY}.`);
  }

  // Validate the full destination too: an existing filename may itself be a
  // symlink that points outside an otherwise allowed directory.
  const destination = canonicalize(join(targetDir, safeFilename));
  if (!allowedBases.some((base) => isWithin(base, destination))) {
    throw new Error(`Access denied: Save destination must be within ${SAVE_ROOTS_DISPLAY}.`);
  }

  return {
    dir: targetDir,
    dest: destination,
  };
}

/**
 * Validates a user-supplied path that will be READ and its contents sent to an
 * external service (e.g. file_upload / doc_upload). Reads are confined to
 * ~/Downloads, ~/Documents and ~/Desktop — deliberately NOT ~/.eule (which holds
 * config.yaml with cleartext credentials and the token store) nor arbitrary
 * locations such as ~/.ssh. Prevents a prompt-injected model from exfiltrating
 * secrets by uploading them to the cloud.
 *
 * @returns the resolved absolute path, safe to read.
 */
export function secureReadPath(userInputPath: string): string {
  const home = homedir();
  const allowedBases = [join(home, "Downloads"), join(home, "Documents"), join(home, "Desktop")];
  const resolved = expandAndResolve(userInputPath);

  if (!allowedBases.some((base) => isWithin(base, resolved))) {
    throw new Error(
      `Access denied: files to upload must be within ~/Downloads, ~/Documents, or ~/Desktop.`,
    );
  }
  return resolved;
}
