// tiers.js — pick a 1-based difficulty row from a game's TIERS table.
export function tier(TIERS, n) {
  const i = Math.max(1, Math.min(TIERS.length, n | 0)) - 1;
  return TIERS[i];
}
