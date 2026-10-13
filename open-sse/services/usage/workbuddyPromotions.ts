export interface WorkbuddyPromotion {
  id: string;
  modelIds: string[];
  validUntil: string;
}

/** Advertisement metadata only; this never overrides pricing or proves free billing. */
export function activeWorkbuddyPromotions(value: unknown, now = Date.now()): WorkbuddyPromotion[] {
  if (!Array.isArray(value)) return [];
  const result: WorkbuddyPromotion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const discount =
      p.discount && typeof p.discount === "object" ? (p.discount as Record<string, unknown>) : {};
    const schedule =
      p.schedule && typeof p.schedule === "object" ? (p.schedule as Record<string, unknown>) : {};
    if (p.enabled !== true || discount.factor !== 0 || typeof p.id !== "string") continue;
    if (typeof schedule.validFrom !== "string" || typeof schedule.validUntil !== "string") continue;
    const start = Date.parse(schedule.validFrom);
    const end = Date.parse(schedule.validUntil);
    if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) continue;
    const modelIds = Array.isArray(p.modelIds)
      ? p.modelIds.filter(
          (id: unknown): id is string =>
            typeof id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(id)
        )
      : [];
    if (!modelIds.length) continue;
    result.push({ id: p.id, modelIds, validUntil: new Date(end).toISOString() });
  }
  return result;
}
