use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::state::{Config, NativeTokenConfig};

#[derive(Accounts)]
pub struct RegisterNativeToken<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = NativeTokenConfig::SPACE,
        seeds = [b"token_config", mint.key().as_ref()],
        bump
    )]
    pub token_config: Account<'info, NativeTokenConfig>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<RegisterNativeToken>,
    min_amount: u64,
    max_amount: u64,
) -> Result<()> {
    let cfg = &mut ctx.accounts.token_config;
    cfg.mint = ctx.accounts.mint.key();
    cfg.enabled = true;
    cfg.min_amount = min_amount;
    cfg.max_amount = max_amount;
    cfg.decimals = ctx.accounts.mint.decimals;
    cfg.bump = ctx.bumps.token_config;
    Ok(())
}
