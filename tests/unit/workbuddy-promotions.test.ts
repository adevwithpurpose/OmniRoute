import assert from "node:assert/strict";
import { it } from "node:test";
import { activeWorkbuddyPromotions } from "../../open-sse/services/usage/workbuddyPromotions.ts";
it("only advertises enabled zero-cost offers inside explicit validity windows", () => {
  const good = {
    id: "offer",
    enabled: true,
    modelIds: ["hy3"],
    discount: { factor: 0 },
    schedule: { validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-11-01T00:00:00Z" },
  };
  const now = Date.parse("2026-10-13T00:00:00Z");
  assert.equal(activeWorkbuddyPromotions([good], now).length, 1);
  assert.equal(activeWorkbuddyPromotions([{ ...good, enabled: false }], now).length, 0);
  assert.equal(activeWorkbuddyPromotions([{ ...good, discount: { factor: 1 } }], now).length, 0);
  assert.equal(activeWorkbuddyPromotions([good], Date.parse("2026-11-01T00:00:00Z")).length, 0);
  assert.equal(activeWorkbuddyPromotions([{ ...good, schedule: {} }], now).length, 0);
  assert.equal(activeWorkbuddyPromotions([null, {}, good], now).length, 1);
});
