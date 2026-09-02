use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::state::{Config, WrappedTokenConfig};

#[derive(Accounts)]
#[instruction(source_token: [u8; 20], source_chain_id: u64, decimals: u8)]
pub struct RegisterWrappedToken<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: PDA mint authority for every wrapped token this program controls.
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        mint::decimals = decimals,
        mint::authority = mint_authority,
    )]
    pub wrapped_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = WrappedTokenConfig::SPACE,
        seeds = [b"wrapped".as_ref(), source_chain_id.to_le_bytes().as_ref(), source_token.as_ref()],
        bump
    )]
    pub wrapped_token_config: Account<'info, WrappedTokenConfig>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<RegisterWrappedToken>,
    source_token: [u8; 20],
    source_chain_id: u64,
    decimals: u8,
) -> Result<()> {
    let cfg = &mut ctx.accounts.wrapped_token_config;
    cfg.source_token = source_token;
    cfg.source_chain_id = source_chain_id;
    cfg.wrapped_mint = ctx.accounts.wrapped_mint.key();
    cfg.decimals = decimals;
    cfg.bump = ctx.bumps.wrapped_token_config;
    Ok(())
}
