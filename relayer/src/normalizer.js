// Decimal normalization for cross-chain token amounts.
//
// Different tokens use different decimal counts (USDC: 6, WBTC: 8, BRT: 18).
// Passing raw amounts across chains without normalization would silently
// destroy value — e.g. 1 USDC (1_000_000) minted as if it were 18-decimal
// would produce 0.000000000001 tokens on the other side.
//
// The fix: every amount is normalized to 18 decimals in transit. Both the
// contracts and this module implement the identical math so the two sides
// never disagree.
//
// All values are BigInt to avoid floating point precision loss.

const NORMALIZED_DECIMALS = 18n;

function normalize(amount, decimals) {
  const d = BigInt(decimals);
  const amt = BigInt(amount);
  if (d === NORMALIZED_DECIMALS) return amt;
  if (d < NORMALIZED_DECIMALS) return amt * (10n ** (NORMALIZED_DECIMALS - d));
  return amt / (10n ** (d - NORMALIZED_DECIMALS));
}

function denormalize(normalized, decimals) {
  const d = BigInt(decimals);
  const norm = BigInt(normalized);
  if (d === NORMALIZED_DECIMALS) return norm;
  if (d < NORMALIZED_DECIMALS) return norm / (10n ** (NORMALIZED_DECIMALS - d));
  return norm * (10n ** (d - NORMALIZED_DECIMALS));
}

module.exports = { normalize, denormalize, NORMALIZED_DECIMALS };
