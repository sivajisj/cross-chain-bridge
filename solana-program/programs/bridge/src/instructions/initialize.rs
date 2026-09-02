use anchor_lang::prelude::*;

use crate::error::BridgeError;
use crate::state::Config;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<Initialize>, validators: [Pubkey; 5], threshold: u8) -> Result<()> {
    require!(
        threshold >= 1 && threshold <= 5,
        BridgeError::InvalidThreshold
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.validators = validators;
    config.threshold = threshold;
    config.paused = false;
    config.bump = ctx.bumps.config;

    Ok(())
}
