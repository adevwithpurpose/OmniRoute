/**
 * Structured logger for the OmniRoute plugin.
 *
 * Levels: error < warn < info < debug
 * Default: warn
 * Set via features.logLevel in plugin options.
 *
 * Sink policy (TUI-pollution fix, 2026-08-23):
 *   error          → console.error AND the file sink
 *   warn/info/debug → file sink ONLY
 *
 * The console mirror for warn/info/debug can be re-enabled for interactive
 * debugging via `OMNIROUTE_PLUGIN_LOG_CONSOLE=1` or by passing
 * `{ consoleMirror: true }` to `configureLogFileSink`.
 *
 * The file sink is a size-capped rotating log:
 *   - rotates at `maxBytes` (default 256KB) to `<fileName>.old`
 *   - if rotation keeps failing (e.g. another process holds the file),
 *     appends stop at the hard cap (`2 × maxBytes`) so the on-disk
 *     footprint can never run away
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const TAG = "[omniroute-plugin]";

export const LOG_FILE_DEFAULT_MAX_BYTES = 256 * 1024;
const FILE_HARD_CAP_FACTOR = 2;
/** Stat the active file only every N appends — rotation need not be exact. */
const STAT_EVERY_N_WRITES = 16;
/** Bound on tracked in-flight writes so flushLogFileSink() stays cheap. */
const PENDING_WRITE_TRACK_LIMIT = 64;

function shouldLog(current: LogLevel, target: LogLevel): boolean {
  return LEVEL_ORDER[current] >= LEVEL_ORDER[target];
}

let _level: LogLevel = "warn";

export function setLogLevel(level: LogLevel): void {
  _level = level;
}

export function getLogLevel(): LogLevel {
  return _level;
}

function fmt(level: LogLevel, msg: string, tag?: string): string {
  const prefix = tag ? `${TAG}${tag}` : TAG;
  return `${prefix} [${level.toUpperCase()}] ${msg}`;
}

// ── File sink ────────────────────────────────────────────────────────────

let _sinkDir: string | null = null;
let _sinkFile = "omniroute-plugin.log";
let _sinkMaxBytes = LOG_FILE_DEFAULT_MAX_BYTES;
let _consoleMirror = process.env.OMNIROUTE_PLUGIN_LOG_CONSOLE === "1";
let _writesSinceStat = 0;
let _rotationBlocked = false;
let _pendingWrites: Promise<void>[] = [];
/** Serializes sink writes: rotation must never race an open append handle. */
let _sinkChain: Promise<void> = Promise.resolve();

export interface LogFileSinkOptions {
  fileName?: string;
  maxBytes?: number;
  consoleMirror?: boolean;
}

/**
 * Point the logger's file sink at a directory. Pass `null` to disable file
 * logging entirely (console-only mode). Idempotent per process; multiple
 * plugin instances pointing at the same directory safely share one file.
 */
export function configureLogFileSink(dir: string | null, opts?: LogFileSinkOptions): void {
  // Re-evaluate the env default on every configure so tests (and runtime
  // toggles) can flip the mirror via OMNIROUTE_PLUGIN_LOG_CONSOLE.
  _consoleMirror = opts?.consoleMirror ?? process.env.OMNIROUTE_PLUGIN_LOG_CONSOLE === "1";
  _sinkDir = dir;
  if (!dir) return;
  if (opts?.fileName) _sinkFile = opts.fileName;
  if (opts?.maxBytes && opts.maxBytes > 0) _sinkMaxBytes = opts.maxBytes;
}

/** Await all in-flight file-sink writes (test/integration convenience). */
export function flushLogFileSink(): Promise<void> {
  const pending = _pendingWrites;
  _pendingWrites = [];
  return Promise.allSettled(pending).then(() => {});
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  const hardCap = _sinkMaxBytes * FILE_HARD_CAP_FACTOR;
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      _rotationBlocked = false; // no active file yet — nothing to rotate
    } else {
      _rotationBlocked = true; // cannot stat — be conservative
    }
    return;
  }
  // While rotation is blocked, keep appending up to the hard cap so recent
  // diagnostics survive; past it, drop lines until a rename finally succeeds.
  if (_rotationBlocked && size >= hardCap) return;
  if (size < _sinkMaxBytes) {
    _rotationBlocked = false;
    return;
  }
  try {
    await rename(filePath, `${filePath}.old`);
    _rotationBlocked = false; // recovered — e.g. the other holder closed it
  } catch {
    _rotationBlocked = true; // EPERM/EBUSY (Windows share locks)
  }
}

async function writeToSink(stamped: string): Promise<void> {
  const dir = _sinkDir;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, _sinkFile);
  if (_writesSinceStat >= STAT_EVERY_N_WRITES || _rotationBlocked) {
    _writesSinceStat = 0;
    await rotateIfNeeded(filePath);
  }
  _writesSinceStat++;
  await appendFile(filePath, stamped, "utf8");
}

function emitToFile(level: LogLevel, line: string): void {
  if (!_sinkDir) return;
  const stamped = `${new Date().toISOString()} ${line}\n`;
  // Chain writes so a rename never races an in-flight append handle — on
  // Windows that fails with EPERM/EBUSY and would starve rotation forever.
  const p = _sinkChain
    .then(() => writeToSink(stamped))
    .catch(() => {
      /* best-effort: logging must never break the caller */
    });
  _sinkChain = p;
  _pendingWrites.push(p);
  if (_pendingWrites.length > PENDING_WRITE_TRACK_LIMIT) {
    _pendingWrites = _pendingWrites.slice(-PENDING_WRITE_TRACK_LIMIT / 2);
  }
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

function emit(
  getLevel: () => LogLevel,
  level: LogLevel,
  msg: string,
  args: unknown[],
  tag?: string
): void {
  if (!shouldLog(getLevel(), level)) return;
  const rest = args.length > 0 ? ` ${args.map(stringifyArg).join(" ")}` : "";
  const line = fmt(level, `${msg}${rest}`, tag);
  emitToFile(level, line);
  if (level === "error" || _consoleMirror) {
    (level === "error" ? console.error : console.warn)(line);
  }
}

function buildLogger(getLevel: () => LogLevel) {
  return {
    error(msg: string, ...args: unknown[]): void {
      emit(getLevel, "error", msg, args);
    },
    warn(msg: string, ...args: unknown[]): void {
      emit(getLevel, "warn", msg, args);
    },
    info(msg: string, ...args: unknown[]): void {
      emit(getLevel, "info", msg, args);
    },
    debug(msg: string, ...args: unknown[]): void {
      emit(getLevel, "debug", msg, args);
    },
    /** Always emit regardless of level (for critical init breadcrumbs). */
    always(msg: string, ...args: unknown[]): void {
      const rest = args.length > 0 ? ` ${args.map((a) => String(a)).join(" ")}` : "";
      emitToFile("warn", fmt("warn", `${msg}${rest}`));
      console.warn(TAG, msg, ...args);
    },

    // ── Tagged child loggers ────────────────────────────────────────────
    child(tag: string) {
      return {
        error: (msg: string, ...args: unknown[]) => emit(getLevel, "error", msg, args, tag),
        warn: (msg: string, ...args: unknown[]) => emit(getLevel, "warn", msg, args, tag),
        info: (msg: string, ...args: unknown[]) => emit(getLevel, "info", msg, args, tag),
        debug: (msg: string, ...args: unknown[]) => emit(getLevel, "debug", msg, args, tag),
      };
    },
  };
}

export type Logger = ReturnType<typeof buildLogger>;

/** Create an instance-scoped logger whose level cannot be changed by other plugin instances. */
export function createLogger(level: LogLevel): Logger {
  return buildLogger(() => level);
}

/** Backward-compatible module-global logger controlled by setLogLevel(). */
export const logger: Logger = buildLogger(() => _level);
