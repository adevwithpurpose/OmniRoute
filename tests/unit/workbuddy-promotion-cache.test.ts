import assert from "node:assert/strict";
import { it } from "node:test";
import { extractWorkbuddyPromotionCache } from "../../open-sse/services/usage/workbuddyPromotionCache.ts";
it("extracts only promotional metadata, not account data", () => {
  const data = [
    { userId: "private", data: { modelPromotions: [{ id: "offer" }], accessToken: "secret" } },
  ];
  assert.deepEqual(extractWorkbuddyPromotionCache(data), [{ id: "offer" }]);
  assert.deepEqual(extractWorkbuddyPromotionCache({ accessToken: "secret" }), []);
});
