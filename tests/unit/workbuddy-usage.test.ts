import assert from "node:assert/strict";
import { findExistingOAuthConnectionMatch } from "../../src/lib/oauth/connectionPersistence.ts";
import { it } from "node:test";
import { USAGE_SUPPORTED_PROVIDERS } from "../../open-sse/services/usage/supportedProviders.ts";
import { USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage/fetcherProviders.ts";
import { getWorkbuddyUsage } from "../../open-sse/services/usage/workbuddy.ts";
it("recognizes legacy WorkBuddy rows without stored email by exact credential equality", () => {
  const rows = [{ id: "legacy", authType: "oauth", accessToken: "fixture-token" }];
  assert.equal(
    findExistingOAuthConnectionMatch(rows, "workbuddy", {
      email: "fixture@example.com",
      accessToken: "fixture-token",
    })?.id,
    "legacy"
  );
  assert.equal(
    findExistingOAuthConnectionMatch(rows, "workbuddy", {
      email: "fixture@example.com",
      accessToken: "different",
    }),
    undefined
  );
});
it("matches duplicate WorkBuddy OAuth identity rather than adding capacity", () => {
  const rows = [{ id: "one", email: "fixture@example.com", authType: "oauth" }];
  assert.equal(
    findExistingOAuthConnectionMatch(rows, "workbuddy", { email: "fixture@example.com" })?.id,
    "one"
  );
  assert.equal(
    findExistingOAuthConnectionMatch(rows, "workbuddy", { email: "different@example.com" }),
    undefined
  );
});
it("records the authenticated account email for future OAuth connections", async () => {
  const { workbuddy } = await import("../../src/lib/oauth/providers/workbuddy.ts");
  const payload = Buffer.from(
    JSON.stringify({ email: "fixture@example.com", email_verified: true })
  ).toString("base64url");
  const mapped = workbuddy.mapTokens({
    access_token: `header.${payload}.signature`,
    refresh_token: "fixture",
    token_type: "Bearer",
  });
  assert.equal(mapped.email, "fixture@example.com");
});

it("uses the client summary balance including bonus and monthly credits", async () => {
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("workbuddy"));
  assert.ok(USAGE_FETCHER_PROVIDERS.includes("workbuddy"));
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://www.workbuddy.ai/billing/meter/get-user-resource-summary");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "CLI/2.108.1 CodeBuddy/2.108.1");
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          SubscriptionPackageName: "Free",
          Packages: [
            { CycleTotalCapacity: "360", CycleRemainCapacity: "172.88" },
            { CycleTotalCapacity: "100", CycleRemainCapacity: "100" },
          ],
        },
      }),
      { status: 200 }
    );
  };
  try {
    const r = await getWorkbuddyUsage("fixture");
    const q = r.quotas?.["Credits Balance"];
    assert.ok(q);
    assert.equal(q.total, 460);
    assert.equal(q.total - q.used, 272.88);
  } finally {
    globalThis.fetch = original;
  }
});
