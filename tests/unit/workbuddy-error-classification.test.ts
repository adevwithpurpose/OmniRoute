import assert from "node:assert/strict";
import { it } from "node:test";
import {
  classifyProviderError,
  PROVIDER_ERROR_TYPES,
} from "../../open-sse/services/errorClassifier.ts";
it("classifies WorkBuddy model code11102 at HTTP400 without blanket retries", () => {
  assert.equal(
    classifyProviderError(400, { code: 11102, message: "model [bad] service info not found" }),
    PROVIDER_ERROR_TYPES.MODEL_NOT_FOUND
  );
  assert.notEqual(
    classifyProviderError(400, { code: 11128, message: "first message is not system prompt" }),
    PROVIDER_ERROR_TYPES.RATE_LIMITED
  );
});
