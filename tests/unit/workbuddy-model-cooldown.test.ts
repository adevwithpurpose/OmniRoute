import assert from "node:assert/strict";
import { it } from "node:test";
import { createProviderConnection, getProviderConnectionById } from "../../src/lib/db/providers.ts";
import { markAccountUnavailable } from "../../src/sse/services/auth.ts";
import { isModelLocked } from "../../open-sse/services/accountFallback.ts";
it("WorkBuddy429 locks only the named model, leaving other models and account active", async () => {
  const c = await createProviderConnection({
    provider: "workbuddy",
    authType: "oauth",
    accessToken: "fixture",
    isActive: true,
  });
  const id = String(c.id);
  await markAccountUnavailable(id, 429, "rate limit exceeded", "workbuddy", "deepseek-v4.1-flash");
  const after = await getProviderConnectionById(id);
  assert.ok(!after?.rateLimitedUntil);
  assert.equal(after?.isActive, true);
  assert.equal(isModelLocked("workbuddy", id, "deepseek-v4.1-flash"), true);
  assert.equal(isModelLocked("workbuddy", id, "hy3"), false);
});
