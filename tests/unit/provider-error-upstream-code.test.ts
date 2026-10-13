import assert from "node:assert/strict";
import { it } from "node:test";
import { formatProviderError } from "../../open-sse/utils/error.ts";
it("preserves an upstream code alongside the HTTP status", () => {
  assert.equal(
    formatProviderError(
      { code: 11102, message: "model service info not found" },
      "workbuddy",
      "bad",
      400
    ),
    "[400]: model service info not found (upstream code: 11102)"
  );
  assert.equal(
    formatProviderError({ code: 400, message: "bad" }, "workbuddy", "bad", 400),
    "[400]: bad"
  );
  assert.equal(formatProviderError({ message: "bad" }, "openai", "bad", 400), "[400]: bad");
});
