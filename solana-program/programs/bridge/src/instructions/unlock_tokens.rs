use anchor_lang::prelude::*;
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::ed25519::verify_threshold_signatures;
use crate::error::BridgeError;
use crate::events::UnlockExecuted;
use crate::message::{denormalize, signing_digest};
use crate::state::{Config, NativeTokenConfig, ProcessedNonce, SOLANA_CHAIN_ID};

#[derive(Accounts)]
#[instruction(message_id: [u8; 32], normalized_amount: u128, source_chain_id: u64)]
pub struct UnlockTokens<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [b"token_config", mint.key().as_ref()],
        bump = token_config.bump,
        constraint = token_config.mint == mint.key()
    )]
    pub token_config: Account<'info, NativeTokenConfig>,

    /// CHECK: PDA authority over this mint's vault.
    #[account(seeds = [b"vault_authority", mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = vault_authority)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: the credited account's pubkey; only its address is used, both
    /// to derive the recipient ATA and as part of the signed message.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = ProcessedNonce::SPACE,
        seeds = [b"nonce", message_id.as_ref()],
        bump
    )]
    pub nonce: Account<'info, ProcessedNonce>,

    /// CHECK: address-checked against the well-known sysvar ID; read via
    /// load_instruction_at_checked in ed25519::verify_threshold_signatures.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<UnlockTokens>,
    message_id: [u8; 32],
    normalized_amount: u128,
    source_chain_id: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, BridgeError::Paused);

    let digest = signing_digest(
        &message_id,
        &ctx.accounts.recipient.key(),
        normalized_amount,
        source_chain_id,
        SOLANA_CHAIN_ID,
        &crate::ID,
    );
    verify_threshold_signatures(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.config.validators,
        ctx.accounts.config.threshold,
        &digest,
    )?;

    ctx.accounts.nonce.message_id = message_id;

    let unlock_amount = denormalize(normalized_amount, ctx.accounts.token_config.decimals)?;
    require!(unlock_amount > 0, BridgeError::ZeroAmount);

    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.bumps.vault_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault_authority", mint_key.as_ref(), &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        unlock_amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(UnlockExecuted {
        message_id,
        recipient: ctx.accounts.recipient.key(),
        mint: ctx.accounts.mint.key(),
        amount: unlock_amount,
    });

    Ok(())
}
