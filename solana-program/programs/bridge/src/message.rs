use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::error::BridgeError;

const NORMALIZED_DECIMALS: u32 = 18;

// Converts an 18-decimal canonical amount (what validators sign, matching
// relayer/src/normalizer.js) into the target mint's native decimal amount.
// Mirrors BridgeDest.sol's `denormalize`, just in u128/u64 instead of
// Solidity's uint256.
pub fn denormalize(normalized: u128, decimals: u8) -> Result<u64> {
    let decimals = decimals as u32;
    let raw: u128 = if decimals == NORMALIZED_DECIMALS {
        normalized
    } else if decimals < NORMALIZED_DECIMALS {
        normalized / 10u128.pow(NORMALIZED_DECIMALS - decimals)
    } else {
        normalized
            .checked_mul(10u128.pow(decimals - NORMALIZED_DECIMALS))
            .ok_or(BridgeError::AmountOverflow)?
    };
    u64::try_from(raw).map_err(|_| error!(BridgeError::AmountOverflow))
}

// Builds the exact byte preimage validators sign for a mint/unlock request,
// then sha256-hashes it. This 32-byte digest is what's actually passed as
// the `message` in each threshold Ed25519Program instruction -- the ed25519
// equivalent of the EIP-712 struct hash on the EVM side. Every integer is
// fixed-width big-endian so the encoding is unambiguous and matches
// relayer/src/solana/signer.js byte-for-byte.
pub fn signing_digest(
    message_id: &[u8; 32],
    recipient: &Pubkey,
    normalized_amount: u128,
    source_chain_id: u64,
    dest_chain_id: u64,
    program_id: &Pubkey,
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(32 + 32 + 16 + 8 + 8 + 32);
    preimage.extend_from_slice(message_id);
    preimage.extend_from_slice(&recipient.to_bytes());
    preimage.extend_from_slice(&normalized_amount.to_be_bytes());
    preimage.extend_from_slice(&source_chain_id.to_be_bytes());
    preimage.extend_from_slice(&dest_chain_id.to_be_bytes());
    preimage.extend_from_slice(&program_id.to_bytes());
    hash(&preimage).to_bytes()
}
