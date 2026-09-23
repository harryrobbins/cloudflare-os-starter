export const PROCGEN_POLICY = Object.freeze({
  defaultQueryLimit: 50,
  maxQueryLimit: 100,
  maxSelectedFields: 16,
  maxPredicates: 4,
  maxMetrics: 8,
  defaultGroupLimit: 25,
  maxGroups: 100,
  maxCursorBytes: 1024,
  defaultTableLimit: 2_000,
  maxTableLimit: 20_000,
  maxTableFields: 32,
  maxInValues: 50,
  maxFacetFields: 8,
  /** Records one table() or facetCounts() call may generate, joined records included. */
  maxScanRecords: 200_000,
  maxSeedLength: 64,
  seedPattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
});

export const PROFILE_CARDINALITIES = Object.freeze({
  small: { customers: 1_000, products: 500, orders: 10_000, order_items: 30_000, events: 50_000, daily_metrics: 730 },
  medium: { customers: 100_000, products: 10_000, orders: 1_000_000, order_items: 3_000_000, events: 5_000_000, daily_metrics: 730 },
});
export type SizeProfile = keyof typeof PROFILE_CARDINALITIES;
