import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Eight attempts, at most 16 MiB each (128 MiB total). Exclusive fixed slots
// bound accumulation across process restarts too; the operator uses a fresh
// private directory for each approved synthetic reproduction.
const MAX_CAPTURES = 8;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type CaptureResult =
  | { state: "disabled" }
  | { state: "written"; file: string; bytes: number }
  | {
      state: "skipped";
      reason: "body_too_large" | "unsafe_directory" | "capture_limit" | "capture_failed";
    };

/** Capture the serialized fetch body, never headers/credentials. Opt-in only:
 * bodies still contain sensitive prompt/tool data, so use synthetic traffic,
 * owner-only files, an isolated directory and a short capture window.
 * Failure must not change the upstream request or leak raw exception text.
 */
export function captureClaudeWireBody(
  provider: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env
): CaptureResult {
  if (provider !== "claude" || env.OMNIROUTE_DUMP_CLAUDE_BODY !== "1") {
    return { state: "disabled" };
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) return { state: "skipped", reason: "body_too_large" };
  const dir = env.OMNIROUTE_DUMP_CLAUDE_BODY_DIR || path.join(os.homedir(), ".omniroute", "dumps");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (st.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && st.uid !== process.getuid())
    ) {
      return { state: "skipped", reason: "unsafe_directory" };
    }
    for (let slot = 0; slot < MAX_CAPTURES; slot++) {
      const file = path.join(dir, `claude-body-${slot}.json`);
      let fd: number;
      try {
        fd = fs.openSync(
          file,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        fs.writeFileSync(fd, body, { encoding: "utf8" });
      } catch {
        // The incomplete exclusive slot stays occupied: never delete an artifact
        // or risk overwriting another capture in a retry.
        return { state: "skipped", reason: "capture_failed" };
      } finally {
        fs.closeSync(fd);
      }
      return { state: "written", file, bytes };
    }
    return { state: "skipped", reason: "capture_limit" };
  } catch {
    return { state: "skipped", reason: "capture_failed" };
  }
}
