import { analyzeAudit } from "../../scripts/diagnostics/analyze-claude-continuity.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  withClaudeContinuityAudit,
  recordContinuityStage,
  recordContinuityStore,
  recordContinuityHttp,
} from "../../open-sse/services/claudeContinuityAudit.ts";
import {
  storeClaudeThinkingFromResponse,
  restoreClaudeThinkingLayout,
  clearClaudeThinkingStore,
  CLAUDE_THINKING_MEMORY_TTL_MS,
} from "../../open-sse/services/claudeThinkingStore.ts";
import { BaseExecutor } from "../../open-sse/executors/base.ts";
const model = "claude-opus-5-5";
function fixture() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "continuity-audit-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}
function read(dir: string) {
  return fs
    .readdirSync(dir)
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}
function body() {
  return {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "test-dummy-private-thought",
            signature: "test-dummy-private-signature",
          },
          {
            type: "tool_use",
            id: "test-dummy-private-tool",
            name: "test-dummy-private-name",
            input: { password: "test-dummy-private-value" },
          },
        ],
      },
    ],
  };
}
async function run(dir: string, fn: () => unknown, noLog = false) {
  const flag = process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT,
    old = process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR;
  process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT = "1";
  process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR = dir;
  try {
    return await withClaudeContinuityAudit(
      { provider: "claude", correlationId: "test-dummy-correlation", noLog },
      fn
    );
  } finally {
    if (flag === undefined) delete process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT;
    else process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT = flag;
    if (old === undefined) delete process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR;
    else process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR = old;
  }
}

test("analyzer distinguishes corrupted wire from clean and refuses a false green on incomplete", () => {
  const stage = (stage: string, signature: string) => ({
    kind: "stage",
    stage,
    turns: [
      {
        index: 31,
        blocks: [
          { type: "thinking", signature },
          { type: "tool_use", tool: "test-dummy-pseudonym" },
        ],
      },
    ],
  });
  const clean = {
    schema: 1,
    correlationId: "test-dummy-id",
    events: [stage("executor_input", "one"), stage("wire", "one")],
  };
  assert.equal(analyzeAudit(clean).verdict, "NO_EXECUTOR_TO_WIRE_DIFFERENCE_OBSERVED");
  assert.equal(
    analyzeAudit({ ...clean, events: [stage("executor_input", "one"), stage("wire", "two")] })
      .verdict,
    "EXECUTOR_TO_WIRE_DIFFERENCE_OBSERVED"
  );
  assert.equal(analyzeAudit({ ...clean, droppedEvents: 1 }).verdict, "PARTIAL_EVIDENCE");
});

test("concurrent requests retain independent correlations across awaits", async () => {
  const dir = fixture();
  try {
    const old = process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR;
    process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR = dir;
    try {
      const env = {
        OMNIROUTE_CLAUDE_CONTINUITY_AUDIT: "1",
        OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR: dir,
      };
      await Promise.all(
        ["test-dummy-a", "test-dummy-b"].map((correlationId, i) =>
          withClaudeContinuityAudit(
            { provider: "claude", correlationId },
            async () => {
              await new Promise((r) => setTimeout(r, i ? 1 : 5));
              recordContinuityHttp(i ? 400 : 200);
            },
            env
          )
        )
      );
      const rows = read(dir);
      assert.equal(rows.length, 2);
      assert.equal(rows.find((x) => x.correlationId === "test-dummy-a").events[0].status, 200);
      assert.equal(rows.find((x) => x.correlationId === "test-dummy-b").events[0].status, 400);
    } finally {
      if (old === undefined) delete process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR;
      else process.env.OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR = old;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled and noLog paths do not write or alter input", async () => {
  const dir = fixture();
  try {
    const b = body(),
      before = JSON.stringify(b);
    withClaudeContinuityAudit({ provider: "claude" }, () => recordContinuityStage("wire", b), {});
    await run(dir, () => recordContinuityStage("wire", b), true);
    assert.equal(fs.readdirSync(dir).length, 0);
    assert.equal(JSON.stringify(b), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("privacy-safe stages identify mutation beyond block64 and retain correlation plus status", async () => {
  const dir = fixture();
  try {
    await run(dir, () => {
      const b = body();
      b.messages[0].content.unshift(
        ...(Array.from({ length: 75 }, () => ({
          type: "text",
          text: "test-dummy-hidden-text",
        })) as never[])
      );
      recordContinuityStage("translated", b);
      (b.messages[0].content[75] as { signature: string }).signature =
        "test-dummy-changed-signature";
      recordContinuityStage("wire", b);
      recordContinuityStore("attacker-raw-error", ["test-dummy-private-tool"]);
      recordContinuityHttp(400);
    });
    const a = read(dir)[0],
      text = JSON.stringify(a);
    for (const secret of [
      "test-dummy-private-thought",
      "test-dummy-private-signature",
      "test-dummy-private-tool",
      "test-dummy-private-name",
      "test-dummy-private-value",
      "test-dummy-hidden-text",
      "attacker-raw-error",
    ])
      assert.equal(text.includes(secret), false);
    const stages = a.events.filter((e: { kind: string }) => e.kind === "stage");
    assert.equal(stages[0].turns[0].blocks[75].index, 75);
    assert.notEqual(
      stages[0].turns[0].blocks[75].signature,
      stages[1].turns[0].blocks[75].signature
    );
    assert.equal(a.correlationId, "test-dummy-correlation");
    assert.equal(a.events.at(-1).status, 400);
    assert.equal(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real store distinguishes hit, text mismatch, missing and expired without changing replay", async () => {
  const dir = fixture();
  clearClaudeThinkingStore();
  try {
    await run(dir, () => {
      const content = [
        { type: "thinking", thinking: "", signature: "test-dummy-sig" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "test-dummy-id", name: "read", input: {} },
      ];
      assert(storeClaudeThinkingFromResponse({ model, content }, { provider: "claude", model }));
      const args = {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "test-dummy-id" },
        ],
        provider: "claude",
        model,
      };
      assert(restoreClaudeThinkingLayout(args));
      assert.equal(
        restoreClaudeThinkingLayout({
          ...args,
          content: [
            { type: "text", text: "edited" },
            { type: "tool_use", id: "test-dummy-id" },
          ],
        }),
        null
      );
      assert.equal(
        restoreClaudeThinkingLayout({
          ...args,
          content: [{ type: "tool_use", id: "test-dummy-missing" }],
        }),
        null
      );
      const now = Date.now;
      try {
        Date.now = () => now() + CLAUDE_THINKING_MEMORY_TTL_MS + 1;
        assert.equal(restoreClaudeThinkingLayout(args), null);
      } finally {
        Date.now = now;
      }
      recordContinuityHttp(400);
    });
    const reasons = read(dir)[0]
      .events.filter((e: { kind: string }) => e.kind === "store")
      .map((e: { reason: string }) => e.reason);
    for (const reason of [
      "stored",
      "restored",
      "layout_restored",
      "text_length_mismatch",
      "missing",
      "expired",
    ])
      assert(reasons.includes(reason), reason);
  } finally {
    clearClaudeThinkingStore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("symlink capture directories are refused without touching the target", async () => {
  const dir = fixture();
  const link = `${dir}-link`;
  try {
    fs.symlinkSync(dir, link);
    await run(link, () => recordContinuityStage("wire", body()));
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("correlation filter does not collect unrelated traffic", async () => {
  const dir = fixture();
  try {
    withClaudeContinuityAudit(
      { provider: "claude", correlationId: "test-dummy-other" },
      () => recordContinuityHttp(400),
      {
        OMNIROUTE_CLAUDE_CONTINUITY_AUDIT: "1",
        OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_DIR: dir,
        OMNIROUTE_CLAUDE_CONTINUITY_AUDIT_CORRELATION: "test-dummy-target",
      }
    );
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unsafe directories and slot exhaustion refuse writes without throwing", async () => {
  const dir = fixture();
  try {
    fs.chmodSync(dir, 0o755);
    await run(dir, () => recordContinuityStage("wire", body()));
    assert.equal(fs.readdirSync(dir).length, 0);
    fs.chmodSync(dir, 0o700);
    for (let i = 0; i < 128; i++)
      fs.writeFileSync(path.join(dir, `continuity-${i}.json`), "test-dummy-slot", { mode: 0o600 });
    await run(dir, () => recordContinuityStage("wire", body()));
    assert.equal(fs.readdirSync(dir).length, 128);
    assert.equal(fs.readFileSync(path.join(dir, "continuity-0.json"), "utf8"), "test-dummy-slot");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded events and projection explicitly mark incomplete instead of silent truncation", async () => {
  const dir = fixture();
  try {
    await run(dir, () => {
      recordContinuityStage("wire", {
        messages: Array.from({ length: 1100 }, () => ({ role: "user", content: "test-dummy" })),
      });
      for (let i = 0; i < 140; i++) recordContinuityStore("missing", []);
      recordContinuityHttp(400);
    });
    const a = read(dir)[0];
    assert.equal(a.events[0].incomplete, true);
    assert(a.events.length <= 128);
    assert(a.droppedEvents > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("actual executor observes final wire and status; enabled/disabled bytes identical", async () => {
  const dir = fixture();
  const original = globalThis.fetch;
  const captures: string[] = [];
  class E extends BaseExecutor {
    constructor() {
      super("claude", { baseUrls: ["https://audit.example.test/v1/messages"] });
    }
    needsRefresh() {
      return false;
    }
    async transformRequest(_m: string, b: Record<string, unknown>) {
      return { ...b };
    }
  }
  globalThis.fetch = async (_u: unknown, init?: RequestInit) => {
    captures.push(String(init?.body));
    return new Response("{}", { status: 400 });
  };
  try {
    const exec = () =>
      new E().execute({
        model,
        body: body(),
        stream: false,
        credentials: { apiKey: "test-dummy-key" },
      });
    await exec();
    await run(dir, exec);
    assert.equal(captures[0], captures[1]);
    const events = read(dir)[0].events;
    assert(events.some((e: { stage: string }) => e.stage === "executor_input"));
    assert(events.some((e: { stage: string }) => e.stage === "wire"));
    assert(
      events.some((e: { kind: string; status: number }) => e.kind === "http" && e.status === 400)
    );
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
