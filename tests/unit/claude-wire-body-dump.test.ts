import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureClaudeWireBody } from "../../open-sse/executors/claudeWireBodyDump.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "claude-wire-test-"));
  const dir = path.join(root, "dumps");
  return {
    root,
    dir,
    env: { OMNIROUTE_DUMP_CLAUDE_BODY: "1", OMNIROUTE_DUMP_CLAUDE_BODY_DIR: dir },
  };
}

test("disabled and non-Claude calls create no dump directory", () => {
  const f = fixture();
  try {
    assert.equal(captureClaudeWireBody("claude", "{}", {}).state, "disabled");
    assert.equal(captureClaudeWireBody("openai", "{}", f.env).state, "disabled");
    assert.equal(
      captureClaudeWireBody("claude", "{}", { ...f.env, OMNIROUTE_DUMP_CLAUDE_BODY: "true" }).state,
      "disabled"
    );
    assert.equal(fs.existsSync(f.dir), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("enabled capture preserves wire bytes exactly with private modes", () => {
  const f = fixture();
  try {
    const body = '{ "messages": [{"content":"unicode 🙂 and \\n"}], "model":"test-dummy" }';
    const r = captureClaudeWireBody("claude", body, f.env);
    assert.equal(r.state, "written");
    if (r.state !== "written") return;
    assert.deepEqual(fs.readFileSync(r.file), Buffer.from(body));
    assert.equal(r.bytes, Buffer.byteLength(body));
    assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("eight exclusive slots bound captures without overwriting prior bodies", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i++)
      assert.equal(captureClaudeWireBody("claude", `{"turn":${i}}`, f.env).state, "written");
    const before = fs
      .readdirSync(f.dir)
      .sort()
      .map((n) => [n, fs.readFileSync(path.join(f.dir, n), "utf8")]);
    assert.deepEqual(captureClaudeWireBody("claude", "test-dummy-extra-body", f.env), {
      state: "skipped",
      reason: "capture_limit",
    });
    assert.deepEqual(
      fs
        .readdirSync(f.dir)
        .sort()
        .map((n) => [n, fs.readFileSync(path.join(f.dir, n), "utf8")]),
      before
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("oversize UTF-8 body is refused before creating files", () => {
  const f = fixture();
  try {
    assert.deepEqual(captureClaudeWireBody("claude", "🙂".repeat(4 * 1024 * 1024 + 1), f.env), {
      state: "skipped",
      reason: "body_too_large",
    });
    assert.equal(fs.existsSync(f.dir), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("insecure directory and symlink directory are refused without modifying targets", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.dir, { mode: 0o755 });
    fs.chmodSync(f.dir, 0o755);
    assert.deepEqual(captureClaudeWireBody("claude", "{}", f.env), {
      state: "skipped",
      reason: "unsafe_directory",
    });
    fs.rmdirSync(f.dir);
    const target = path.join(f.root, "private-target");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, f.dir);
    assert.deepEqual(captureClaudeWireBody("claude", "{}", f.env), {
      state: "skipped",
      reason: "unsafe_directory",
    });
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("occupied or symlink capture slot is never followed or replaced", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.dir, { mode: 0o700 });
    const target = path.join(f.root, "sentinel");
    fs.writeFileSync(target, "test-dummy-preserve");
    for (let i = 0; i < 8; i++) fs.symlinkSync(target, path.join(f.dir, `claude-body-${i}.json`));
    assert.deepEqual(captureClaudeWireBody("claude", "{}", f.env), {
      state: "skipped",
      reason: "capture_limit",
    });
    assert.equal(fs.readFileSync(target, "utf8"), "test-dummy-preserve");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("filesystem failure returns fixed metadata, not body or raw exception", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.dir, "test-dummy-file-not-directory");
    const r = captureClaudeWireBody("claude", "test-dummy-private-content", f.env);
    assert.deepEqual(r, { state: "skipped", reason: "capture_failed" });
    assert.equal(JSON.stringify(r).includes("test-dummy-private-content"), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
