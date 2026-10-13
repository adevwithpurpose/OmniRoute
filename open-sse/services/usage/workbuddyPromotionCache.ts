import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { activeWorkbuddyPromotions, type WorkbuddyPromotion } from "./workbuddyPromotions.ts";

export function extractWorkbuddyPromotionCache(value: unknown): unknown[] {
  const entries = Array.isArray(value) ? value : [value];
  const promotions: unknown[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const data = (e.data && typeof e.data === "object" ? e.data : e) as Record<string, unknown>;
    if (Array.isArray(data.modelPromotions)) promotions.push(...data.modelPromotions);
  }
  return promotions;
}

let cache: { at: number; offers: WorkbuddyPromotion[]; observedAt: string | null } | undefined;
/** Optional local-client advertisement, never account entitlement or billing evidence. */
export async function readWorkbuddyPromotionCache(now = Date.now()) {
  if (cache && now - cache.at < 60000)
    return { ...cache, offers: cache.offers.filter((p) => Date.parse(p.validUntil) > now) };
  const directory = join(homedir(), ".workbuddy-ai", "local_storage");
  const offers = new Map<string, WorkbuddyPromotion>();
  let observedAt: string | null = null;
  try {
    const files = (await readdir(directory))
      .filter((n) => /^wb_entry_[a-f0-9]+\.info$/.test(n))
      .slice(0, 64);
    for (const name of files) {
      try {
        const path = join(directory, name);
        const info = await stat(path);
        if (info.size > 2 * 1024 * 1024) continue;
        const value = JSON.parse(await readFile(path, "utf8"));
        const active = activeWorkbuddyPromotions(extractWorkbuddyPromotionCache(value), now);
        if (active.length) {
          for (const offer of active) offers.set(offer.id, offer);
          const date = info.mtime.toISOString();
          if (!observedAt || date > observedAt) observedAt = date;
        }
      } catch {
        /* Missing/malformed client cache is optional, never log its content. */
      }
    }
  } catch {
    /* Client need not be installed. */
  }
  cache = { at: now, offers: [...offers.values()], observedAt };
  return cache;
}
