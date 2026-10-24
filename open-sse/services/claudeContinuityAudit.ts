import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Metadata only, explicitly opt-in. Never write request bodies, signatures,
// error strings, credentials, tool names/arguments, text, or raw tool IDs.
const context = new AsyncLocalStorage<Audit>();
const key = randomBytes(32); // process-local pseudonyms, not persisted
const stages = new Set(["ingress", "translated", "executor_input", "wire", "store_snapshot"]);
const reasons = new Set([
  "stored",
  "invalid_capture",
  "missing",
  "expired",
  "evicted",
  "binding_mismatch",
  "tool_sequence_mismatch",
  "restored",
  "text_length_mismatch",
  "text_digest_mismatch",
  "unsupported_content",
  "layout_mismatch",
  "layout_restored",
  "legacy_layout",
]);
const MAX_EVENTS = 128;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_SLOTS = 128;
const MAX_MESSAGES = 1024;
const MAX_BLOCKS = 4096;
const MAX_HASH_BYTES = 16 * 1024 * 1024;
type Audit = {
  correlationId: string | null;
  startedAt: string;
  events: unknown[];
  droppedEvents: number;
  file: string | null;
  sink: "pending" | "written" | "full" | "unsafe" | "failed" | "oversize";
};

export function continuityAuditEnabled(): boolean {
  return !!context.getStore();
}
export function continuityAuditToken(value: string): string {
  return createHmac("sha256", key).update(value).digest("hex").slice(0, 24);
}
function enabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT === "1" &&
    !!env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR &&
    path.isAbsolute(env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR)
  );
}
export function withClaudeContinuityAudit<T>(
  args: { provider?: unknown; correlationId?: unknown; noLog?: boolean },
  fn: () => T,
  env: NodeJS.ProcessEnv = process.env
): T {
  if (args.provider !== "claude" || args.noLog || !enabled(env)) return fn();
  if (
    typeof env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_CORRELATION === "string" &&
    env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_CORRELATION !== args.correlationId
  )
    return fn();
  const audit: Audit = {
    correlationId:
      typeof args.correlationId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(args.correlationId)
        ? args.correlationId
        : null,
    startedAt: new Date().toISOString(),
    events: [],
    droppedEvents: 0,
    file: null,
    sink: "pending",
  };
  return context.run(audit, fn);
}
function privateDir(dir: string): boolean {
  // Refuse symlinks in every ancestor. Never follow an operator typo into a
  // public or redirected capture tree; the destination itself must be private.
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return false;
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
  }
  const st = fs.lstatSync(dir);
  return (
    (st.mode & 0o077) === 0 && (typeof process.getuid !== "function" || st.uid === process.getuid())
  );
}
function persist(a: Audit): void {
  if (a.sink === "full" || a.sink === "unsafe" || a.sink === "failed" || a.sink === "oversize")
    return;
  try {
    const dir = process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR;
    if (!dir || !privateDir(dir)) {
      a.sink = "unsafe";
      return;
    }
    if (!a.file) {
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const candidate = path.join(dir, `continuity-${slot}.json`);
        try {
          const fd = fs.openSync(
            candidate,
            fs.constants.O_WRONLY |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_NOFOLLOW,
            0o600
          );
          fs.closeSync(fd);
          a.file = candidate;
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
      if (!a.file) {
        a.sink = "full";
        return;
      }
    }
    a.sink = "written";
    const data = JSON.stringify({ schema: 1, ...a, file: undefined });
    if (Buffer.byteLength(data) > MAX_FILE) {
      a.sink = "oversize";
      return;
    }
    // Reopen no-follow and verify inode owner/mode before every update.
    const fd = fs.openSync(
      a.file,
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const st = fs.fstatSync(fd);
      if (
        !st.isFile() ||
        (st.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && st.uid !== process.getuid())
      )
        throw Error("unsafe_sink");
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    a.sink = "failed";
  }
}
function emit(event: Record<string, unknown>): void {
  const a = context.getStore();
  if (!a) return;
  if (
    a.events.length >= MAX_EVENTS ||
    (event.kind === "store" && a.events.length >= MAX_EVENTS - 16)
  )
    a.droppedEvents++;
  else a.events.push({ at: new Date().toISOString(), ...event });
  // Store reasons are flushed by the next stage/status. Avoid disk I/O per
  // historical tool lookup; stage snapshots reserve space even on long histories.
  if (event.kind !== "store") persist(a);
}
export function recordContinuityStore(reason: string, toolIds: unknown = [], ageMs?: number): void {
  if (!context.getStore()) return;
  const ids = Array.isArray(toolIds)
    ? toolIds.filter((v): v is string => typeof v === "string")
    : [];
  emit({
    kind: "store",
    reason: reasons.has(reason) ? reason : "invalid_capture",
    toolCount: ids.length,
    tools: ids.slice(0, 128).map(continuityAuditToken),
    ageMs:
      typeof ageMs === "number" && Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : null,
  });
}
export function flushContinuityAudit(): void {
  const a = context.getStore();
  if (a) persist(a);
}
export function recordContinuityStage(stage: string, body: unknown): void {
  if (!context.getStore() || !stages.has(stage)) return;
  try {
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const messages = Array.isArray(root.messages) ? root.messages : [];
    let budget = MAX_HASH_BYTES,
      blocksSeen = 0,
      incomplete = messages.length > MAX_MESSAGES;
    function digest(value: unknown): string | null {
      if (typeof value !== "string") return null;
      const bytes = Buffer.byteLength(value);
      if (bytes > budget) {
        incomplete = true;
        return null;
      }
      budget -= bytes;
      return continuityAuditToken(value);
    }
    const turns: unknown[] = [];
    for (let index = 0; index < Math.min(messages.length, MAX_MESSAGES); index++) {
      const m = messages[index];
      if (!m || typeof m !== "object") continue;
      const role = ["assistant", "user", "tool", "system", "developer"].includes(m.role)
        ? m.role
        : "unknown";
      const content = Array.isArray(m.content) ? m.content : [];
      const blocks: unknown[] = [];
      for (let j = 0; j < content.length; j++) {
        if (++blocksSeen > MAX_BLOCKS) {
          incomplete = true;
          break;
        }
        const b = content[j];
        if (!b || typeof b !== "object") continue;
        const type = ["thinking", "redacted_thinking", "tool_use", "tool_result", "text"].includes(
          b.type
        )
          ? b.type
          : "other";
        if (type === "thinking" || type === "redacted_thinking") {
          blocks.push({
            index: j,
            type,
            signed: typeof b.signature === "string" && b.signature.length > 0,
            thinking: digest(b.thinking),
            signature: digest(b.signature),
            data: digest(b.data),
            fieldCount: Object.keys(b).length,
          });
        } else if (type === "tool_use" || type === "tool_result")
          blocks.push({ index: j, type, tool: digest(type === "tool_use" ? b.id : b.tool_use_id) });
        else blocks.push({ index: j, type });
      }
      const calls = Array.isArray(m.tool_calls)
        ? m.tool_calls.slice(0, 128).map((t: { id?: unknown }) => digest(t?.id))
        : [];
      if (role === "assistant" || role === "tool" || role === "user")
        turns.push({ index, role, blocks, calls, blockCount: content.length });
      if (blocksSeen > MAX_BLOCKS) break;
    }
    emit({ kind: "stage", stage, messageCount: messages.length, incomplete, turns });
  } catch {
    emit({ kind: "stage", stage, incomplete: true, projectionFailed: true });
  }
}
export function recordContinuityHttp(status: number): void {
  if (Number.isInteger(status) && status >= 100 && status <= 599) emit({ kind: "http", status });
}
