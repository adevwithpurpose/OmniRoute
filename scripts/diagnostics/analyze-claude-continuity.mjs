#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Consume only the allowlisted metadata format, never raw wire captures.
export function analyzeAudit(a) {
  if (!a || a.schema !== 1 || !Array.isArray(a.events)) throw Error("invalid_audit");
  const allowed = new Set([
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
  const counts = {};
  for (const e of a.events)
    if (e.kind === "store" && allowed.has(e.reason)) counts[e.reason] = (counts[e.reason] || 0) + 1;
  const snapshots = a.events.filter((e) => e.kind === "stage");
  const incomplete =
    !!a.droppedEvents ||
    snapshots.some((e) => e.incomplete) ||
    !snapshots.some((e) => e.stage === "wire");
  function groups(snapshot) {
    const out = new Map();
    for (const turn of snapshot?.turns || []) {
      const thinking = (turn.blocks || [])
        .filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
        .map((b) => ({
          type: b.type,
          thinking: b.thinking,
          signature: b.signature,
          data: b.data,
          fieldCount: b.fieldCount,
        }));
      for (const block of turn.blocks || [])
        if (block.type === "tool_use" && typeof block.tool === "string")
          out.set(block.tool, {
            thinking,
            order: turn.blocks.map((b) => b.type),
            index: turn.index,
          });
    }
    return out;
  }
  const changes = [];
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].stage !== "wire") continue;
    const before = [...snapshots.slice(0, i)].reverse().find((e) => e.stage === "executor_input");
    if (!before) continue;
    const previous = groups(before),
      wire = groups(snapshots[i]);
    let changedThinking = 0,
      changedLayout = 0,
      missingTurns = 0;
    for (const [tool, turn] of previous) {
      const after = wire.get(tool);
      if (!after) {
        missingTurns++;
        continue;
      }
      if (JSON.stringify(turn.thinking) !== JSON.stringify(after.thinking)) changedThinking++;
      if (JSON.stringify(turn.order) !== JSON.stringify(after.order)) changedLayout++;
    }
    changes.push({ dispatch: i, changedThinking, changedLayout, missingTurns });
  }
  return {
    schema: 1,
    correlationId:
      typeof a.correlationId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(a.correlationId)
        ? a.correlationId
        : null,
    incomplete,
    storeReasons: counts,
    stages: snapshots.map((e) =>
      ["ingress", "translated", "executor_input", "wire", "store_snapshot"].includes(e.stage)
        ? e.stage
        : "unknown"
    ),
    httpStatuses: a.events
      .filter(
        (e) => e.kind === "http" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599
      )
      .map((e) => e.status),
    executorToWire: changes,
    verdict: incomplete
      ? "PARTIAL_EVIDENCE"
      : changes.some((c) => c.changedThinking || c.changedLayout || c.missingTurns)
        ? "EXECUTOR_TO_WIRE_DIFFERENCE_OBSERVED"
        : "NO_EXECUTOR_TO_WIRE_DIFFERENCE_OBSERVED",
    limits:
      "Store reasons are observations, not proof of the provider rejection cause. Missing/expired retention is not repairable by inventing signed blocks. Absence of a captured difference does not prove correctness.",
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file)
    throw Error("usage: node scripts/diagnostics/analyze-claude-continuity.mjs <audit.json>");
  const st = fs.statSync(file);
  if (st.size > 2 * 1024 * 1024) throw Error("oversize_audit");
  console.log(JSON.stringify(analyzeAudit(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2));
}
