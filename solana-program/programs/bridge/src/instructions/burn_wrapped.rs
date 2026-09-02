use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount, TokenInterface};

use crate::error::BridgeError;
use crate::events::BurnEvent;
use crate::state::{Config, WrappedTokenConfig};

#[derive(Accounts)]
pub struct BurnWrapped<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [b"wrapped".as_ref(), wrapped_token_config.source_chain_id.to_le_bytes().as_ref(), wrapped_token_config.source_token.as_ref()],
        bump = wrapped_token_config.bump,
        constraint = wrapped_token_config.wrapped_mint == wrapped_mint.key()
    )]
    pub wrapped_token_config: Account<'info, WrappedTokenConfig>,

    #[account(mut)]
    pub wrapped_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, associated_token::mint = wrapped_mint, associated_token::authority = user)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(
    ctx: Context<BurnWrapped>,
    amount: u64,
    dest_chain_id: u64,
    recipient_evm: [u8; 20],
) -> Result<()> {
    require!(!ctx.accounts.config.paused, BridgeError::Paused);
    require!(amount > 0, BridgeError::ZeroAmount);

    burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                from: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(BurnEvent {
        user: ctx.accounts.user.key(),
        wrapped_mint: ctx.accounts.wrapped_mint.key(),
        source_token: ctx.accounts.wrapped_token_config.source_token,
        source_chain_id: ctx.accounts.wrapped_token_config.source_chain_id,
        amount,
        recipient_evm,
        dest_chain_id,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
