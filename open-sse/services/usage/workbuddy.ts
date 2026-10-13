import { WORKBUDDY_USER_AGENT } from "../../config/providerHeaderProfiles.ts";
import type { CodeBuddyUsageResult } from "./codebuddyShared.ts";
import { readWorkbuddyPromotionCache } from "./workbuddyPromotionCache.ts";

/** Same balance source as the official client, including every credit package. */
export async function getWorkbuddyUsage(
  accessToken?: string,
  apiKey?: string,
  _providerSpecificData?: unknown
): Promise<CodeBuddyUsageResult> {
  const token = accessToken || apiKey;
  if (!token) return { message: "WorkBuddy credential not available." };
  try {
    const response = await fetch(
      "https://www.workbuddy.ai/billing/meter/get-user-resource-summary",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Product": "SaaS",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": WORKBUDDY_USER_AGENT,
        },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!response.ok) return { message: `WorkBuddy balance API error (${response.status}).` };
    const json = await response.json();
    if (json.code !== 0 || !Array.isArray(json.data?.Packages))
      return { message: "WorkBuddy balance response unavailable." };
    let total = 0;
    let remaining = 0;
    for (const pkg of json.data.Packages) {
      const size = Number(pkg.CycleTotalCapacity);
      const left = Number(pkg.CycleRemainCapacity);
      if (!Number.isFinite(size) || !Number.isFinite(left) || size < 0 || left < 0 || left > size)
        return { message: "WorkBuddy balance response invalid." };
      total += size;
      remaining += left;
    }
    const promotionCache = await readWorkbuddyPromotionCache();
    const message = promotionCache.offers.length
      ? `Client-advertised free offers (not billing-verified; cache ${promotionCache.observedAt}): ${promotionCache.offers.map((p) => `${p.modelIds.join(", ")} until ${p.validUntil}`).join("; ")}`
      : undefined;
    return {
      message,
      plan: json.data.SubscriptionPackageName || "WorkBuddy",
      quotas: {
        "Credits Balance": { used: total - remaining, total, resetAt: null, unlimited: false },
      },
    };
  } catch {
    return { message: "WorkBuddy balance fetch failed." };
  }
}
