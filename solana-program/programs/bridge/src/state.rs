use anchor_lang::prelude::*;

// Solana devnet's identifier in the relayer's bridge_messages/sync_cursor
// tables. Not a real EVM chain ID -- just a unique tag, same idea as
// 11155111 (Sepolia) and 80002 (Amoy) already in use there.
pub const SOLANA_CHAIN_ID: u64 = 901;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub validators: [Pubkey; 5],
    pub threshold: u8,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 + (32 * 5) + 1 + 1 + 1;
}

// A native Solana (SPL) token this program is allowed to custody in its
// vault on behalf of the Sepolia leg. Mirrors TokenRegistry.sol's
// per-token allow-list on the EVM side.
#[account]
pub struct NativeTokenConfig {
    pub mint: Pubkey,
    pub enabled: bool,
    pub min_amount: u64,
    pub max_amount: u64,
    pub decimals: u8,
    pub bump: u8,
}

impl NativeTokenConfig {
    pub const SPACE: usize = 8 + 32 + 1 + 8 + 8 + 1 + 1;
}

// A wrapped SPL mint this program controls, representing one specific
// EVM-origin ERC-20. Mirrors BridgeDest.sol's per-source-token
// WrappedToken deployment.
#[account]
pub struct WrappedTokenConfig {
    pub source_token: [u8; 20],
    pub source_chain_id: u64,
    pub wrapped_mint: Pubkey,
    pub decimals: u8,
    pub bump: u8,
}

impl WrappedTokenConfig {
    pub const SPACE: usize = 8 + 20 + 8 + 32 + 1 + 1;
}

// Existence alone is the replay guard: init fails if a message_id has
// already been processed, exactly like BridgeSource/BridgeDest's
// `processedNonces` mapping on the EVM side.
#[account]
pub struct ProcessedNonce {
    pub message_id: [u8; 32],
}

impl ProcessedNonce {
    pub const SPACE: usize = 8 + 32;
}
