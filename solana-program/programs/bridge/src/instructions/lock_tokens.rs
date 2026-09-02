use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::BridgeError;
use crate::events::LockEvent;
use crate::state::{Config, NativeTokenConfig};

#[derive(Accounts)]
pub struct LockTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [b"token_config", mint.key().as_ref()],
        bump = token_config.bump,
        constraint = token_config.mint == mint.key()
    )]
    pub token_config: Account<'info, NativeTokenConfig>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = user)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA authority over every native token's vault.
    #[account(seeds = [b"vault_authority", mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<LockTokens>, amount: u64, dest_chain_id: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, BridgeError::Paused);
    require!(ctx.accounts.token_config.enabled, BridgeError::TokenDisabled);
    require!(amount > 0, BridgeError::ZeroAmount);
    require!(
        amount >= ctx.accounts.token_config.min_amount
            && amount <= ctx.accounts.token_config.max_amount,
        BridgeError::AmountOutOfRange
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(LockEvent {
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        dest_chain_id,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
