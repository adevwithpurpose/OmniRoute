import { BaseExecutor } from "../../open-sse/executors/base.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";
import {
  clearClaudeThinkingStore,
  storeClaudeThinkingFromResponse,
} from "../../open-sse/services/claudeThinkingStore.ts";

const model = "claude-opus-5-5";
for (const count of [12, 40]) {
  test(`captured ${count}-turn boundary pattern preserves original blocks after completed assistant and next user`, () => {
    // Structure measured in captures18→19 and123→125; all bytes below SYNTHETIC.
    clearClaudeThinkingStore();
    const messages: Record<string, unknown>[] = [{ role: "user", content: "test-dummy-task" }];
    const expected: Record<string, unknown>[][] = [];
    for (let i = 0; i < count; i++) {
      const id = `test-dummy-tool-${i}`;
      const signed = [
        { type: "thinking", thinking: "", signature: `test-dummy-sig-${i}` },
        { type: "redacted_thinking", data: `test-dummy-opaque-${i}` },
      ];
      const content = [
        ...signed,
        { type: "tool_use", id, name: "read", input: { path: "example" } },
      ];
      assert(storeClaudeThinkingFromResponse({ model, content }, { provider: "claude", model }));
      expected.push(signed);
      messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name: "read", arguments: '{"path":"example"}' } },
          ],
        },
        { role: "tool", tool_call_id: id, content: "test-dummy-result" }
      );
    }
    const convert = (input: Record<string, unknown>[]) =>
      translateRequest(
        "openai",
        "claude",
        model,
        { reasoning_effort: "high", messages: structuredClone(input) },
        true,
        null,
        "claude"
      );
    const before = convert(messages);
    messages.push(
      { role: "assistant", content: "test-dummy-complete" },
      { role: "user", content: "test-dummy-next-task" }
    );
    const after = convert(messages);
    const signedOf = (body: typeof after) =>
      body.messages
        .filter(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "tool_use")
        )
        .map((m) =>
          Array.isArray(m.content)
            ? m.content.filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
            : []
        );
    assert.deepEqual(signedOf(before), expected);
    assert.deepEqual(
      signedOf(after),
      expected,
      "completed boundary must not fabricate replacement blocks"
    );
    assert.equal(
      JSON.stringify(after),
      JSON.stringify(convert(messages)),
      "repeat result must be deterministic"
    );
    clearClaudeThinkingStore();
  });
}

test("completed-loop originals survive the actual executor serialization boundary", async () => {
  clearClaudeThinkingStore();
  const signed = { type: "thinking", thinking: "", signature: "test-dummy-wire-completed" };
  assert(
    storeClaudeThinkingFromResponse(
      {
        model,
        content: [
          signed,
          { type: "tool_use", id: "test-dummy-wire-tool", name: "read", input: {} },
        ],
      },
      { provider: "claude", model }
    )
  );
  const body = translateRequest(
    "openai",
    "claude",
    model,
    {
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "test-dummy-task" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "test-dummy-wire-tool",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "test-dummy-wire-tool", content: "test-dummy-result" },
        { role: "assistant", content: "test-dummy-complete" },
        { role: "user", content: "test-dummy-next-task" },
      ],
    },
    true,
    null,
    "claude"
  );
  class Executor extends BaseExecutor {
    constructor() {
      super("claude", { baseUrls: ["https://completed.example.test/v1/messages"] });
    }
    needsRefresh() {
      return false;
    }
    async transformRequest(_model: string, input: Record<string, unknown>) {
      return { ...input };
    }
  }
  const original = globalThis.fetch;
  let wire = "";
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    wire = String(init?.body);
    return new Response("{}", { status: 200 });
  };
  try {
    await new Executor().execute({
      model,
      body,
      stream: false,
      credentials: { apiKey: "test-dummy-key" },
    });
    assert(wire, "actual executor must reach the fetch stub");
    const parsed = JSON.parse(wire) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    assert.deepEqual(
      parsed.messages[1].content.find((b) => b.type === "thinking"),
      signed
    );
  } finally {
    globalThis.fetch = original;
    clearClaudeThinkingStore();
  }
});

test("client-supplied historical blocks do not gain restoration provenance", () => {
  const original = {
    type: "thinking",
    thinking: "test-dummy-client-thought",
    signature: "test-dummy-client-signature",
  };
  const out = prepareClaudeRequest(
    {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: [{ type: "text", text: "task" }] },
        {
          role: "assistant",
          content: [
            { ...original },
            { type: "tool_use", id: "test-dummy-id", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "test-dummy-id", content: "done" }],
        },
        { role: "assistant", content: [{ type: "text", text: "complete" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
    },
    "claude",
    false,
    model
  );
  const content = out.messages?.[1].content;
  assert(Array.isArray(content));
  assert.equal(content[0].type, "redacted_thinking");
});
