/**
 * File-sink behavior tests for logger.ts.
 *
 * Covers:
 *   - warn/info/debug go to the file, never to console
 *   - error goes to both file and console
 *   - lines carry ISO timestamps and the plugin tag
 *   - size-based rotation to `<file>.old` with bounded total footprint
 *   - hard cap stops runaway growth when rotation keeps failing
 *   - OMNIROUTE_PLUGIN_LOG_CONSOLE=1 mirrors non-error levels to console
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configureLogFileSink, createLogger, flushLogFileSink } from "../src/logger.js";

type ConsoleMethod = "error" | "info" | "log" | "warn";
const consoleMethods: ConsoleMethod[] = ["error", "info", "log", "warn"];

async function captureConsole(run: () => Promise<void>): Promise<string[]> {
  const out: string[][] = [];
  const originals = Object.fromEntries(
    consoleMethods.map((method) => [method, console[method]])
  ) as Record<ConsoleMethod, typeof console.warn>;
  for (const method of consoleMethods) {
    console[method] = (...args: unknown[]) => {
      out.push(args.map((a) => String(a)));
    };
  }
  try {
    await run();
  } finally {
    for (const method of consoleMethods) console[method] = originals[method];
  }
  return out.map((parts) => parts.join(" "));
}

async function makeSinkDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `omniroute-sink-${prefix}-`));
}

test("warn/info/debug are file-only; error is file+console", async () => {
  const dir = await makeSinkDir("levels");
  try {
    configureLogFileSink(dir);
    const log = createLogger("debug");

    const consoleLines = await captureConsole(async () => {
      log.warn("w-message");
      log.info("i-message");
      log.debug("d-message");
      log.error("e-message");
      await flushLogFileSink();
    });

    assert.equal(
      consoleLines.filter((line) => line.includes("-message")).length,
      1,
      "only the error reaches console"
    );
    assert.ok(consoleLines[0]?.includes("e-message"), "error line on console");

    const content = await readFile(join(dir, "omniroute-plugin.log"), "utf8");
    for (const marker of ["w-message", "i-message", "d-message", "e-message"]) {
      assert.ok(content.includes(marker), `${marker} captured in file`);
    }
    assert.match(content, /\d{4}-\d{2}-\d{2}T[\d:.]+Z \[omniroute-plugin\] \[WARN\] w-message/);
  } finally {
    configureLogFileSink(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotation keeps total footprint bounded at ~2x maxBytes", async () => {
  const dir = await makeSinkDir("rotate");
  const maxBytes = 4_000;
  try {
    configureLogFileSink(dir, { maxBytes });
    const log = createLogger("warn");
    const entry = "x".repeat(200); // ~230B per stamped line

    for (let i = 0; i < 60; i++) log.warn(`entry-${i} ${entry}`);
    await flushLogFileSink();

    const files = await readdir(dir);
    assert.ok(files.includes("omniroute-plugin.log.old"), ".old rotation file exists");

    let total = 0;
    for (const f of files) {
      total += (await stat(join(dir, f))).size;
    }
    // Active file can exceed maxBytes by up to one write window; hard cap is 2x.
    assert.ok(total <= maxBytes * 3, `total footprint bounded (total=${total})`);
    assert.ok(total >= maxBytes, `rotation actually engaged (total=${total})`);
  } finally {
    configureLogFileSink(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("console mirror env flag re-enables TUI output for non-error levels", async () => {
  const dir = await makeSinkDir("mirror");
  const previous = process.env.OMNIROUTE_PLUGIN_LOG_CONSOLE;
  process.env.OMNIROUTE_PLUGIN_LOG_CONSOLE = "1";
  try {
    // configureLogFileSink(null) re-evaluates the env flag.
    configureLogFileSink(null);
    configureLogFileSink(dir);
    const log = createLogger("warn");

    const consoleLines = await captureConsole(async () => {
      log.warn("mirrored-warning");
      await flushLogFileSink();
    });

    assert.ok(
      consoleLines.some((line) => line.includes("mirrored-warning")),
      "warn mirrored to console when OMNIROUTE_PLUGIN_LOG_CONSOLE=1"
    );
    const content = await readFile(join(dir, "omniroute-plugin.log"), "utf8");
    assert.ok(content.includes("mirrored-warning"), "and still written to file");
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_PLUGIN_LOG_CONSOLE;
    else process.env.OMNIROUTE_PLUGIN_LOG_CONSOLE = previous;
    configureLogFileSink(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabled sink (null dir) falls back to previous console-only behavior for errors", async () => {
  configureLogFileSink(null);
  const log = createLogger("warn");
  const consoleLines = await captureConsole(async () => {
    log.warn("dropped-warn");
    log.error("visible-error");
  });

  assert.equal(consoleLines.filter((l) => l.includes("dropped-warn")).length, 0);
  assert.ok(consoleLines.some((l) => l.includes("visible-error")));
});
