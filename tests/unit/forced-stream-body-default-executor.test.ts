// forceStream must reach the outgoing BODY, not just the transport.
//
// chatCore computes `upstreamStream = stream || isClaudeCodeCompatible || providerRequiresStreaming`
// (chatCore.ts:2230) and hands it to `executor.execute({ stream })`, which forwards it as the
// `stream` argument of `transformRequest()`. The default executor's openai branch used to only
// delete `stream_options` when the body carried `stream: false`, leaving the body non-streaming —
// so a streaming-only upstream rejected the call outright (WorkBuddy answers 11101 "Non-stream
// chat request is currently not supported") and `forceStream` never actually worked for any
// `stream: false` client.
//
// Guard: when the caller requires an upstream stream the outgoing body must say `stream: true`;
// when it does not, the body must be left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "@omniroute/open-sse/executors/default.ts";

// Registry entry: format "openai", forceStream: true, executor "default".
const PROVIDER = "workbuddy";
const MODEL = "deepseek-v4.1-flash";

function outbound(callerStream: boolean, bodyOverrides: Record<string, unknown> = {}) {
  const executor = new DefaultExecutor(PROVIDER);
  return executor.transformRequest(
    MODEL,
    { model: MODEL, messages: [{ role: "user", content: "hi" }], ...bodyOverrides },
    callerStream,
    undefined
  ) as Record<string, unknown>;
}

test("a stream:false body is forced to stream:true when the caller requires an upstream stream", () => {
  const body = outbound(true, { stream: false });
  assert.equal(
    body.stream,
    true,
    "forceStream must set stream:true on the outgoing body — otherwise the upstream rejects it (11101)"
  );
});

test("a stream:false body keeps no stale stream_options when it is forced to stream", () => {
  const body = outbound(true, { stream: false, stream_options: { include_usage: false } });
  assert.equal(body.stream, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, "stream_options"),
    false,
    "stream_options sent by a non-streaming client must not survive the forced upgrade"
  );
});

test("no forced streaming when the caller did not ask for it", () => {
  const body = outbound(false, { stream: false });
  assert.equal(body.stream, false, "a genuinely non-streaming caller must not be upgraded");
});

test("an already-streaming body keeps stream:true and gains include_usage", () => {
  const body = outbound(true, { stream: true });
  assert.equal(body.stream, true);
  assert.equal(
    (body.stream_options as Record<string, unknown> | undefined)?.include_usage,
    true,
    "the streaming path still asks upstream for usage"
  );
});
