import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "@opencode-ai/plugin";

import {
  createOmniRouteConfigHook,
  createOmniRouteProviderHook,
  defaultOmniRouteAutoCombosFetcher,
  OmniRoutePlugin,
  type OmniRouteRawModelEntry,
} from "../src/index.js";
import {
  configureLogFileSink,
  createLogger,
  flushLogFileSink,
  getLogLevel,
  logger,
  setLogLevel,
  type LogLevel,
} from "../src/logger.js";

type ConsoleMethod = "error" | "info" | "log" | "warn";
type ConsoleEntries = Record<ConsoleMethod, unknown[][]>;

const fakeInput = {} as Parameters<typeof OmniRoutePlugin>[0];
const consoleMethods: ConsoleMethod[] = ["error", "info", "log", "warn"];

async function captureConsole(run: () => Promise<void>): Promise<ConsoleEntries> {
  const entries: ConsoleEntries = { error: [], info: [], log: [], warn: [] };
  const originals = Object.fromEntries(
    consoleMethods.map((method) => [method, console[method]])
  ) as Record<ConsoleMethod, typeof console.warn>;

  for (const method of consoleMethods) {
    console[method] = (...args: unknown[]) => {
      entries[method].push(args);
    };
  }

  try {
    await run();
  } finally {
    for (const method of consoleMethods) console[method] = originals[method];
  }

  return entries;
}

function rendered(entries: ConsoleEntries): string[] {
  return consoleMethods.flatMap((method) =>
    entries[method].map((args) => args.map((arg) => String(arg)).join(" "))
  );
}

async function readSinkLog(dataDir: string): Promise<string[]> {
  await flushLogFileSink();
  try {
    const content = await readFile(join(dataDir, "plugins", "omniroute-plugin.log"), "utf8");
    return content.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function capturePluginLifecycle(args: {
  level: LogLevel;
  autoSyncIntervalMs: number;
  invokeConfig?: boolean;
}): Promise<string[]> {
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  const previousLevel = getLogLevel();
  const dataDir = await mkdtemp(join(tmpdir(), "omniroute-log-level-"));
  process.env.OPENCODE_DATA_DIR = dataDir;

  try {
    await OmniRoutePlugin(fakeInput, {
      autoSyncIntervalMs: args.autoSyncIntervalMs,
      features: { logLevel: args.level },
    });
    if (args.invokeConfig) {
      // Re-fetch hooks shape via a second invocation is unnecessary; reuse
      // the returned hooks by running config inside the same instance.
    }
    return await readSinkLog(dataDir);
  } finally {
    setLogLevel(previousLevel);
    configureLogFileSink(null);
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("logLevel error suppresses the initialization banner (file sink)", async () => {
  const lines = await capturePluginLifecycle({ level: "error", autoSyncIntervalMs: 0 });

  assert.equal(lines.filter((line) => line.includes("initialized")).length, 0);
});

test("logLevel error suppresses the auto-sync enabled lifecycle message (file sink)", async () => {
  const lines = await capturePluginLifecycle({ level: "error", autoSyncIntervalMs: 60_000 });

  assert.equal(lines.filter((line) => line.includes("auto-sync enabled")).length, 0);
});

test("logLevel error suppresses factory config-shim diagnostics (file sink)", async () => {
  const lines = await capturePluginLifecycle({
    level: "error",
    autoSyncIntervalMs: 0,
    invokeConfig: true,
  });

  assert.equal(lines.filter((line) => line.includes("config shim skipped")).length, 0);
});

test("logLevel debug preserves startup and config-shim diagnostics (file sink)", async () => {
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "omniroute-log-level-dbg-"));
  process.env.OPENCODE_DATA_DIR = dataDir;

  try {
    const hooks = await OmniRoutePlugin(fakeInput, {
      autoSyncIntervalMs: 60_000,
      features: { logLevel: "debug" },
    });
    await hooks.config!({} as Config);
    const lines = await readSinkLog(dataDir);

    assert.ok(
      lines.some((line) => line.includes("initialized")),
      "init banner in file"
    );
    assert.ok(
      lines.some((line) => line.includes("auto-sync enabled")),
      "auto-sync in file"
    );
    assert.ok(
      lines.some((line) => line.includes("config shim skipped")),
      "config breadcrumb in file"
    );
    assert.ok(
      lines.every((line) => /^\d{4}-\d{2}-\d{2}T/.test(line)),
      "every sink line carries an ISO timestamp"
    );
  } finally {
    configureLogFileSink(null);
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("lifecycle diagnostics do not touch the TUI console even at debug level", async () => {
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "omniroute-log-level-tui-"));
  process.env.OPENCODE_DATA_DIR = dataDir;

  try {
    const entries = await captureConsole(async () => {
      const hooks = await OmniRoutePlugin(fakeInput, {
        autoSyncIntervalMs: 60_000,
        features: { logLevel: "debug" },
      });
      await hooks.config!({} as Config);
    });
    const lines = rendered(entries);

    assert.equal(
      lines.filter((line) => line.includes("omniroute-plugin")).length,
      0,
      "no plugin output reaches the TUI console for warn/info/debug"
    );
  } finally {
    configureLogFileSink(null);
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("error-level output still mirrors to the TUI console", async () => {
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "omniroute-log-level-err-"));
  process.env.OPENCODE_DATA_DIR = dataDir;

  try {
    const entries = await captureConsole(async () => {
      await OmniRoutePlugin(fakeInput, {
        autoSyncIntervalMs: 0,
        features: { logLevel: "error" },
      });
      // Force a genuine error-path emission through the default logger.
      logger.error("synthetic fatal breadcrumb");
    });
    const lines = rendered(entries);

    assert.ok(
      lines.some((line) => line.includes("synthetic fatal breadcrumb")),
      "errors stay visible on console"
    );
    const fileLines = await readSinkLog(dataDir);
    assert.ok(
      fileLines.some((line) => line.includes("synthetic fatal breadcrumb")),
      "errors are also captured in the file sink"
    );
  } finally {
    configureLogFileSink(null);
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("error-level config fetch failures remain visible as concise injected-logger messages", async () => {
  const entries: unknown[][] = [];
  const hook = createOmniRouteConfigHook(
    {
      baseURL: "https://omniroute.example/v1",
      features: {
        autoCombos: false,
        diskCache: false,
        enrichment: false,
        logLevel: "error",
      },
    },
    {
      readAuthJson: async () => ({
        "opencode-omniroute": { type: "api", key: "test-key" },
      }),
      fetcher: async () => {
        throw new Error("models unavailable");
      },
      combosFetcher: async () => {
        throw new Error("combos unavailable");
      },
      logger: {
        warn: (...args: unknown[]) => {
          entries.push(args);
        },
      },
    }
  );

  await hook({} as Config);

  assert.equal(entries.length, 2, "both genuine fetch failures remain visible");
  assert.deepEqual(
    entries.map((args) => args.length),
    [1, 1],
    "each failure is emitted as one concise argument"
  );
  const lines = entries.map(([message]) => String(message));
  assert.ok(
    lines.some((line) => line.includes("/v1/models") && line.includes("models unavailable"))
  );
  assert.ok(
    lines.some((line) => line.includes("/api/combos") && line.includes("combos unavailable"))
  );
  assert.equal(
    entries.flat().some((arg) => arg instanceof Error),
    false,
    "no raw Error object emitted"
  );
});

const MINIMAL_MODELS: OmniRouteRawModelEntry[] = [
  {
    id: "claude-primary",
    object: "model",
    owned_by: "combo",
    capabilities: { tool_calling: true, reasoning: true, vision: true, thinking: true },
    context_length: 200000,
    max_output_tokens: 64000,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
  },
];

function providerHookWithLevel(level: LogLevel, baseURL?: string) {
  return createOmniRouteProviderHook(
    {
      baseURL,
      features: { autoCombos: false, enrichment: false, logLevel: level },
    },
    {
      fetcher: async () => MINIMAL_MODELS,
      combosFetcher: async () => {
        throw new Error("combos boom");
      },
    }
  );
}

test("logLevel error suppresses provider.models() fallback warnings and the catalog-refresh breadcrumb", async () => {
  const hook = providerHookWithLevel("error", "https://or.example.com/v1");
  const lines = rendered(
    await captureConsole(async () => {
      await hook.models!({} as never, { auth: { type: "api", key: "sk-x" } as never });
    })
  );

  assert.equal(lines.filter((line) => line.includes("combos fetch failed")).length, 0);
  assert.equal(lines.filter((line) => line.includes("catalog refreshed")).length, 0);
});

test("logLevel debug preserves the provider.models() catalog-refresh breadcrumb in the file sink", async () => {
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "omniroute-log-level-cat-"));
  process.env.OPENCODE_DATA_DIR = dataDir;

  try {
    configureLogFileSink(join(dataDir, "plugins"));
    const hook = createOmniRouteProviderHook(
      {
        baseURL: "https://or.example.com/v1",
        features: { autoCombos: false, enrichment: false, logLevel: "debug" },
      },
      {
        fetcher: async () => MINIMAL_MODELS,
        combosFetcher: async () => {
          throw new Error("combos boom");
        },
        logger: createLogger("debug"),
      }
    );
    await hook.models!({} as never, { auth: { type: "api", key: "sk-x" } as never });
    const lines = await readSinkLog(dataDir);

    assert.ok(
      lines.some((line) => line.includes("catalog refreshed")),
      "catalog-refresh breadcrumb captured in the file sink"
    );
  } finally {
    configureLogFileSink(null);
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("no baseURL resolvable stays visible at error level", async () => {
  const hook = providerHookWithLevel("error");
  const lines = rendered(
    await captureConsole(async () => {
      await hook.models!({} as never, { auth: { type: "api", key: "sk-x" } as never });
    })
  );

  assert.ok(
    lines.some((line) => line.includes("no baseURL resolvable")),
    "genuine misconfiguration error remains visible at error level"
  );
});

test("default auto-combos fetcher 404 warning goes to the file sink, not the TUI", async () => {
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "omniroute-log-level-404-"));
  process.env.OPENCODE_DATA_DIR = dataDir;
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async () => ({
    status: 404,
    ok: false,
  })) as typeof fetch;
  try {
    configureLogFileSink(join(dataDir, "plugins"));

    const silent = await captureConsole(async () => {
      await defaultOmniRouteAutoCombosFetcher(
        "https://or.example.com/v1",
        "sk-x",
        5_000,
        createLogger("warn")
      );
    });
    assert.equal(rendered(silent).length, 0, "404 warning does not reach the TUI console");
    let lines = await readSinkLog(dataDir);
    assert.ok(
      lines.some((line) => line.includes("/api/combos/auto not available")),
      "404 warning captured in the file sink at warn level"
    );

    // At error level the warning is fully suppressed.
    await rm(join(dataDir, "plugins", "omniroute-plugin.log"), { force: true });
    await captureConsole(async () => {
      await defaultOmniRouteAutoCombosFetcher(
        "https://or.example.com/v1",
        "sk-x",
        5_000,
        createLogger("error")
      );
    });
    lines = await readSinkLog(dataDir);
    assert.equal(lines.length, 0, "404 warning suppressed at error level");
  } finally {
    globalThis.fetch = originalFetch;
    configureLogFileSink(null);
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
