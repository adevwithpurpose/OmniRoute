/**
 * Claude signed-thinking continuity store.
 *
 * When a Claude-format upstream answers an OpenAI Chat Completions or Responses
 * client, the client only receives the reasoning TEXT (`reasoning_content` /
 * reasoning summary). The signed `thinking` / `redacted_thinking` blocks that
 * Anthropic needs back on the next tool-loop turn are lost, so openai-to-claude
 * could only send a `redacted_thinking` placeholder (#5312) — the model loses its
 * own reasoning continuity across tool calls.
 *
 * This store keeps the exact signed blocks server-side, keyed by the `tool_use`
 * ids of the assistant turn that produced them (same pattern as
 * geminiThoughtSignatureStore), so the request translator can restore them in
 * front of the owning `tool_use` on the next turn.
 *
 * Invariants:
 * - Memory only, TTL + size bounded. Thinking text and signatures never reach the
 *   DB or any log line (thinkingSignatureDiagnostics invariants).
 * - Bound to provider + model: a signature replayed to a different model or
 *   provider is a hard 400 (#6953), so a binding mismatch restores nothing.
 * - All-or-nothing: a turn is stored only when every thinking-ish block is
 *   replayable (non-empty signature / data); a partial set would reorder the turn.
 */

import {
  continuityAuditEnabled,
  continuityAuditToken,
  recordContinuityStore,
  recordContinuityStage,
  flushContinuityAudit,
} from "./claudeContinuityAudit.ts";
import { createHash } from "node:crypto";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../config/defaultThinkingSignature.ts";

export type ClaudeSignedThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

type LayoutSlot =
  | { type: "thinking" }
  | { type: "text"; length: number; digest: string }
  | { type: "tool_use"; id: string };
const restoredBlocks = new WeakSet<object>();
export function isRestoredClaudeThinkingBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && restoredBlocks.has(block);
}

type Entry = {
  provider: string;
  model: string;
  toolUseIds: string[];
  layout: LayoutSlot[] | null;
  blocks: ClaudeSignedThinkingBlock[];
  size: number;
  expiresAt: number;
};

export const CLAUDE_THINKING_MEMORY_TTL_MS = 1000 * 60 * 60;
export const MAX_CLAUDE_THINKING_ENTRIES = 1000;
/** Upper bound for one assistant turn (sum of thinking text + signature/data chars). */
export const MAX_CLAUDE_THINKING_ENTRY_CHARS = 2 * 1024 * 1024;
const MAX_CLAUDE_THINKING_TOTAL_CHARS = 64 * 1024 * 1024;

const entries = new Map<string, Entry>();
let totalChars = 0;

function normalizeProvider(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

/**
 * Anthropic echoes the dated snapshot (`claude-sonnet-4-5-20250929`) while the
 * request may use the alias (`claude-sonnet-4-5`); both name the same model, so
 * the binding compares the undated form. Any other difference is a different model.
 */
export function normalizeClaudeThinkingModel(model: unknown): string {
  if (typeof model !== "string") return "";
  let normalized = model.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) normalized = normalized.slice(slash + 1);
  return normalized.replace(/-\d{8}$/, "");
}

function normalizeBlock(block: unknown): ClaudeSignedThinkingBlock | null {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  if (record.type === "thinking") {
    if (typeof record.thinking !== "string") return null;
    if (typeof record.signature !== "string" || record.signature.length === 0) return null;
    return { type: "thinking", thinking: record.thinking, signature: record.signature };
  }
  if (record.type === "redacted_thinking") {
    if (typeof record.data !== "string" || record.data.length === 0) return null;
    return { type: "redacted_thinking", data: record.data };
  }
  return null;
}

function blockSize(block: ClaudeSignedThinkingBlock): number {
  return block.type === "thinking"
    ? block.thinking.length + block.signature.length
    : block.data.length;
}

function cloneBlocks(blocks: ClaudeSignedThinkingBlock[]): ClaudeSignedThinkingBlock[] {
  return blocks.map((block) => ({ ...block }));
}

const auditTombstones = new Map<string, { reason: "expired" | "evicted"; at: number }>();
function deleteKey(key: string, reason?: "expired" | "evicted") {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalChars -= entry.size;
  if (reason && continuityAuditEnabled()) {
    auditTombstones.set(continuityAuditToken(key), { reason, at: Date.now() });
    while (auditTombstones.size > 2048)
      auditTombstones.delete(auditTombstones.keys().next().value!);
  }
}

function pruneExpired(now: number) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) deleteKey(key, "expired");
  }
  while (
    entries.size > MAX_CLAUDE_THINKING_ENTRIES ||
    totalChars > MAX_CLAUDE_THINKING_TOTAL_CHARS
  ) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    deleteKey(oldestKey, "evicted");
  }
}

function collectToolUseIds(toolUseIds: unknown): string[] {
  if (!Array.isArray(toolUseIds)) return [];
  return toolUseIds.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Remember the signed thinking blocks of one assistant turn under each of its
 * tool_use ids. No-op unless the turn owns tool calls and every block is replayable.
 */
export function storeClaudeThinkingBlocks(args: {
  toolUseIds: unknown;
  blocks: unknown;
  layout?: LayoutSlot[];
  provider: unknown;
  model: unknown;
}): boolean {
  const stored = storeClaudeThinkingBlocksInner(args);
  if (!stored) {
    recordContinuityStore("invalid_capture", args.toolUseIds);
    flushContinuityAudit();
  }
  return stored;
}
function storeClaudeThinkingBlocksInner(args: {
  toolUseIds: unknown;
  blocks: unknown;
  layout?: LayoutSlot[];
  provider: unknown;
  model: unknown;
}): boolean {
  const toolUseIds = collectToolUseIds(args.toolUseIds);
  const model = normalizeClaudeThinkingModel(args.model);
  if (
    toolUseIds.length === 0 ||
    toolUseIds.length > 128 ||
    new Set(toolUseIds).size !== toolUseIds.length ||
    !Array.isArray(args.toolUseIds) ||
    toolUseIds.length !== args.toolUseIds.length ||
    !model ||
    !Array.isArray(args.blocks)
  )
    return false;
  if (args.blocks.length === 0) return false;

  const blocks = args.blocks.map(normalizeBlock);
  if (!blocks.every(Boolean)) return false;
  const normalizedBlocks = blocks as ClaudeSignedThinkingBlock[];
  if (
    args.layout &&
    (args.layout.length > 4096 ||
      args.layout.filter((slot) => slot.type === "thinking").length !== normalizedBlocks.length ||
      args.layout.some(
        (slot) =>
          slot.type === "text" &&
          (!Number.isSafeInteger(slot.length) ||
            slot.length < 0 ||
            !/^[a-f0-9]{64}$/.test(slot.digest))
      ))
  )
    return false;
  const size =
    normalizedBlocks.reduce((sum, block) => sum + blockSize(block), 0) +
    (args.layout ? JSON.stringify(args.layout).length : 0) +
    toolUseIds.join("").length;
  if (size > MAX_CLAUDE_THINKING_ENTRY_CHARS) return false;

  const now = Date.now();
  const provider = normalizeProvider(args.provider);
  for (const toolUseId of toolUseIds) {
    deleteKey(toolUseId);
    entries.set(toolUseId, {
      provider,
      model,
      toolUseIds: [...toolUseIds],
      layout: args.layout ? args.layout.map((slot) => ({ ...slot })) : null,
      blocks: cloneBlocks(normalizedBlocks),
      size,
      expiresAt: now + CLAUDE_THINKING_MEMORY_TTL_MS,
    });
    totalChars += size;
  }
  pruneExpired(now);
  recordContinuityStore("stored", toolUseIds);
  if (continuityAuditEnabled())
    recordContinuityStage("store_snapshot", {
      messages: [
        {
          role: "assistant",
          content: [...normalizedBlocks, ...toolUseIds.map((id) => ({ type: "tool_use", id }))],
        },
      ],
    });
  return true;
}

/**
 * Non-streaming counterpart of the claude-to-openai stream capture: remember the
 * signed thinking blocks of a complete Claude Messages response that owns tool_use
 * blocks. The response's own `model` wins over the request model, like the stream.
 */
export function storeClaudeThinkingFromResponse(
  responseBody: unknown,
  binding: { provider: unknown; model: unknown }
): boolean {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    return false;
  }
  const root = responseBody as Record<string, unknown>;
  if (root.stop_reason === "content_filter" || root.stop_reason === "max_tokens") return false;
  if (!Array.isArray(root.content)) return false;
  const blocks: unknown[] = [];
  const toolUseIds: unknown[] = [];
  const layout: LayoutSlot[] = [];
  for (const block of root.content) {
    if (!block || typeof block !== "object") return false;
    const value = block as Record<string, unknown>;
    if (value.type === "thinking" || value.type === "redacted_thinking") {
      blocks.push(block);
      layout.push({ type: "thinking" });
    } else if (value.type === "tool_use" && typeof value.id === "string") {
      toolUseIds.push(value.id);
      layout.push({ type: "tool_use", id: value.id });
    } else if (value.type === "text" && typeof value.text === "string") {
      layout.push({
        type: "text",
        length: value.text.length,
        digest: createHash("sha256").update(value.text).digest("hex"),
      });
    } else {
      // Unknown content must not be silently dropped from a signed turn.
      return false;
    }
  }
  return storeClaudeThinkingBlocks({
    toolUseIds,
    blocks,
    layout,
    provider: binding.provider,
    model: typeof root.model === "string" && root.model ? root.model : binding.model,
  });
}

/**
 * Return fresh copies of the signed blocks stored for the first tool_use id that
 * hits with the same provider + model binding, or null.
 */
export function restoreClaudeThinkingBlocks(args: {
  toolUseIds: unknown;
  provider: unknown;
  model: unknown;
}): ClaudeSignedThinkingBlock[] | null {
  const toolUseIds = collectToolUseIds(args.toolUseIds);
  const model = normalizeClaudeThinkingModel(args.model);
  if (toolUseIds.length === 0 || !model) return null;

  pruneExpired(Date.now());
  const provider = normalizeProvider(args.provider);
  for (const toolUseId of toolUseIds) {
    const entry = entries.get(toolUseId);
    if (!entry) continue;
    if (entry.provider !== provider || entry.model !== model) {
      recordContinuityStore("binding_mismatch", toolUseIds);
      return null;
    }
    if (
      entry.toolUseIds.length !== toolUseIds.length ||
      entry.toolUseIds.some((id, index) => id !== toolUseIds[index])
    ) {
      recordContinuityStore("tool_sequence_mismatch", toolUseIds);
      return null;
    }
    recordContinuityStore(
      "restored",
      toolUseIds,
      CLAUDE_THINKING_MEMORY_TTL_MS - (entry.expiresAt - Date.now())
    );
    return cloneBlocks(entry.blocks).map((block) => {
      restoredBlocks.add(block);
      return block;
    });
  }
  if (continuityAuditEnabled()) {
    const tombstone = toolUseIds
      .map((id) => auditTombstones.get(continuityAuditToken(id)))
      .find(Boolean);
    recordContinuityStore(
      tombstone?.reason || "missing",
      toolUseIds,
      tombstone ? Date.now() - tombstone.at : undefined
    );
  }
  return null;
}

export function restoreClaudeThinkingLayout(args: {
  content: Array<Record<string, unknown>>;
  provider: unknown;
  model: unknown;
}): Array<Record<string, unknown>> | null {
  const tools = args.content.filter((block) => block.type === "tool_use");
  const ids = tools.map((block) => block.id);
  const signed = restoreClaudeThinkingBlocks({
    toolUseIds: ids,
    provider: args.provider,
    model: args.model,
  });
  if (!signed) return null;
  const entry = entries.get(String(ids[0]));
  const fail = (reason: string) => {
    recordContinuityStore(reason, ids);
    return null;
  };
  if (!entry?.layout) {
    recordContinuityStore("legacy_layout", ids);
    return [...signed, ...args.content];
  }
  if (args.content.some((block) => block.type !== "text" && block.type !== "tool_use"))
    return fail("unsupported_content");
  const text = args.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  const expectedLength = entry.layout.reduce(
    (n, slot) => n + (slot.type === "text" ? slot.length : 0),
    0
  );
  if (text.length !== expectedLength) return fail("text_length_mismatch");
  const result: Array<Record<string, unknown>> = [];
  let thinkingIndex = 0,
    toolIndex = 0,
    offset = 0;
  for (const slot of entry.layout) {
    if (slot.type === "thinking") {
      const block = signed[thinkingIndex++];
      if (!block) return null;
      result.push(block);
    } else if (slot.type === "tool_use") {
      const block = tools[toolIndex++];
      if (!block || block.id !== slot.id) return null;
      result.push(block); // caller's current arguments, never saved arguments
    } else {
      const segment = text.slice(offset, offset + slot.length);
      if (createHash("sha256").update(segment).digest("hex") !== slot.digest)
        return fail("text_digest_mismatch");
      result.push({ type: "text", text: segment });
      offset += slot.length;
    }
  }
  if (thinkingIndex !== signed.length || toolIndex !== tools.length) return fail("layout_mismatch");
  recordContinuityStore("layout_restored", ids);
  return result;
}

function sameBlock(stored: ClaudeSignedThinkingBlock, block: unknown): boolean {
  const normalized = normalizeBlock(block);
  if (!normalized) return false;
  if (stored.type === "thinking") {
    return normalized.type === "thinking" && normalized.signature === stored.signature;
  }
  return normalized.type === "redacted_thinking" && normalized.data === stored.data;
}

function isStoredBlock(block: unknown): boolean {
  // Provenance is object identity, never caller-supplied signature equality.
  return isRestoredClaudeThinkingBlock(block);
}

function forgetEntriesHolding(blocks: unknown[]) {
  const keys: string[] = [];
  for (const [key, entry] of entries) {
    if (entry.blocks.some((stored) => blocks.some((block) => sameBlock(stored, block)))) {
      keys.push(key);
    }
  }
  for (const key of keys) deleteKey(key);
}

/**
 * Signature-recovery fallback: Anthropic rejected a thinking signature. The
 * active tool-use cycle is otherwise preserved verbatim by the recovery, so any
 * block this store restored there is swapped for the pre-restore #5312
 * `redacted_thinking` placeholder and forgotten, so later turns do not replay it
 * again. Returns null when the content holds no server-restored block.
 */
export function downgradeRestoredClaudeThinking(content: unknown): unknown[] | null {
  if (!Array.isArray(content) || entries.size === 0) return null;
  const restored = content.filter(isStoredBlock);
  if (restored.length === 0) return null;

  forgetEntriesHolding(restored);
  const kept = content.filter((block) => !restored.includes(block));
  const hasThinking = kept.some((block) => {
    const type = (block as Record<string, unknown> | null)?.type;
    return type === "thinking" || type === "redacted_thinking";
  });
  const hasToolUse = kept.some(
    (block) => (block as Record<string, unknown> | null)?.type === "tool_use"
  );
  if (!hasThinking && hasToolUse) {
    kept.unshift({ type: "redacted_thinking", data: DEFAULT_THINKING_CLAUDE_SIGNATURE });
  }
  return kept;
}

/**
 * Drop whatever the stream capture stored for the tool calls of a reconstructed
 * client response (Chat `choices[].message.tool_calls[].id` or Responses
 * `output[].call_id`). Used when the turn must not be retained at all, e.g. a
 * response that may echo video transcript cues.
 */
export function forgetClaudeThinkingForClientResponse(responseBody: unknown): void {
  if (!responseBody || typeof responseBody !== "object" || entries.size === 0) return;
  const root = responseBody as Record<string, unknown>;
  const ids: string[] = [];
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      const toolCalls = (choice as { message?: { tool_calls?: unknown } } | null)?.message
        ?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const toolCall of toolCalls) {
        const id = (toolCall as { id?: unknown } | null)?.id;
        if (typeof id === "string") ids.push(id);
      }
    }
  }
  const output = Array.isArray(root.output)
    ? root.output
    : Array.isArray((root.response as { output?: unknown } | undefined)?.output)
      ? ((root.response as { output: unknown[] }).output as unknown[])
      : [];
  for (const item of output) {
    const callId = (item as { call_id?: unknown } | null)?.call_id;
    if (typeof callId === "string") ids.push(callId);
  }
  for (const id of ids) deleteKey(id);
}

export function clearClaudeThinkingStore() {
  auditTombstones.clear();
  entries.clear();
  totalChars = 0;
}

export function getClaudeThinkingStoreSizeForTests() {
  pruneExpired(Date.now());
  return entries.size;
}
