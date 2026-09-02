pub mod ed25519;
pub mod error;
pub mod events;
pub mod instructions;
pub mod message;
pub mod state;

use anchor_lang::prelude::*;

pub use error::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("HCbnMzyJfg4J49i6YUmBVBPTDtRvv4WphC65qEScCFPV");

#[program]
pub mod bridge {
    use super::*;

    /// Sets up the Config PDA: the 5 validator ed25519 pubkeys and the
    /// signature threshold, mirroring the validator set threshold on the
    /// EVM BridgeSource/BridgeDest contracts.
    pub fn initialize(
        ctx: Context<Initialize>,
        validators: [Pubkey; 5],
        threshold: u8,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, validators, threshold)
    }

    /// Admin: allow-lists a native SPL mint for locking, with a min/max
    /// amount range. Mirrors TokenRegistry.sol's per-token config.
    pub fn register_native_token(
        ctx: Context<RegisterNativeToken>,
        min_amount: u64,
        max_amount: u64,
    ) -> Result<()> {
        instructions::register_native_token::handler(ctx, min_amount, max_amount)
    }

    /// Admin: creates a new program-controlled SPL mint representing one
    /// specific EVM-origin ERC-20. Mirrors BridgeDest.sol's dynamic
    /// WrappedToken deployment per source token.
    pub fn register_wrapped_token(
        ctx: Context<RegisterWrappedToken>,
        source_token: [u8; 20],
        source_chain_id: u64,
        decimals: u8,
    ) -> Result<()> {
        instructions::register_wrapped_token::handler(ctx, source_token, source_chain_id, decimals)
    }

    /// Locks a registered native SPL token into the program vault and
    /// emits a LockEvent for the relayer to pick up. Solana-side mirror of
    /// BridgeSource.sol's lockTokens().
    pub fn lock_tokens(ctx: Context<LockTokens>, amount: u64, dest_chain_id: u64) -> Result<()> {
        instructions::lock_tokens::handler(ctx, amount, dest_chain_id)
    }

    /// Mints wrapped tokens to `recipient` after verifying `threshold`
    /// distinct validator ed25519 signatures over the request, supplied as
    /// Ed25519Program instructions immediately preceding this one in the
    /// same transaction. Solana-side mirror of BridgeDest.sol's mint().
    pub fn mint_wrapped(
        ctx: Context<MintWrapped>,
        message_id: [u8; 32],
        normalized_amount: u128,
        source_chain_id: u64,
        source_token: [u8; 20],
    ) -> Result<()> {
        instructions::mint_wrapped::handler(
            ctx,
            message_id,
            normalized_amount,
            source_chain_id,
            source_token,
        )
    }

    /// Burns wrapped tokens and emits a BurnEvent carrying the EVM
    /// recipient address, for the relayer to submit as an unlock on the
    /// origin chain. Solana-side mirror of BridgeDest.sol's burn().
    pub fn burn_wrapped(
        ctx: Context<BurnWrapped>,
        amount: u64,
        dest_chain_id: u64,
        recipient_evm: [u8; 20],
    ) -> Result<()> {
        instructions::burn_wrapped::handler(ctx, amount, dest_chain_id, recipient_evm)
    }

    /// Releases previously-locked native SPL tokens back to `recipient`
    /// after verifying threshold validator signatures. Solana-side mirror
    /// of BridgeSource.sol's unlockTokens().
    pub fn unlock_tokens(
        ctx: Context<UnlockTokens>,
        message_id: [u8; 32],
        normalized_amount: u128,
        source_chain_id: u64,
    ) -> Result<()> {
        instructions::unlock_tokens::handler(ctx, message_id, normalized_amount, source_chain_id)
    }
}
