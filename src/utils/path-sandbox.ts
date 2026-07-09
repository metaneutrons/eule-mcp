import { resolve, basename, relative, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export interface SecurePathResult {
  dir: string;
  dest: string;
}

const EULE_DIR = join(homedir(), ".eule");

/** Expands a leading `~` to the home directory and resolves to an absolute path. */
function expandAndResolve(inputPath: string): string {
  const expanded = inputPath.startsWith("~") ? join(homedir(), inputPath.slice(1)) : inputPath;
  return resolve(expanded);
}

/** True if `target` is `base` or a descendant of it. */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validates and resolves a user-supplied save path and filename.
 * Restricts saving to safe base directories (~/.eule, ~/Downloads, ~/Documents, ~/Desktop).
 * Sanitizes the filename using path.basename to prevent directory traversal, and refuses
 * to overwrite reserved secret/DB files or to write directly into the ~/.eule root.
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
  ];

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
  if (targetDir === EULE_DIR) {
    throw new Error("Access denied: cannot write into the ~/.eule root; use a subdirectory.");
  }

  // 4. Ensure the target directory is within an allowed base directory.
  if (!allowedBases.some((base) => isWithin(base, targetDir))) {
    throw new Error(
      `Access denied: Save directory must be within ~/.eule, ~/Downloads, ~/Documents, or ~/Desktop.`,
    );
  }

  return {
    dir: targetDir,
    dest: join(targetDir, safeFilename),
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
