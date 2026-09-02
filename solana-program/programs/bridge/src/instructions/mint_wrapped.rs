use anchor_lang::prelude::*;
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{mint_to, Mint, MintTo, TokenAccount, TokenInterface};

use crate::ed25519::verify_threshold_signatures;
use crate::error::BridgeError;
use crate::events::MintExecuted;
use crate::message::{denormalize, signing_digest};
use crate::state::{Config, ProcessedNonce, WrappedTokenConfig, SOLANA_CHAIN_ID};

#[derive(Accounts)]
#[instruction(message_id: [u8; 32], normalized_amount: u128, source_chain_id: u64, source_token: [u8; 20])]
pub struct MintWrapped<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [b"wrapped".as_ref(), source_chain_id.to_le_bytes().as_ref(), source_token.as_ref()],
        bump = wrapped_token_config.bump,
    )]
    pub wrapped_token_config: Account<'info, WrappedTokenConfig>,

    #[account(mut, address = wrapped_token_config.wrapped_mint)]
    pub wrapped_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA mint authority for every wrapped token this program controls.
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: the credited account's pubkey; only its address is used, both
    /// to derive the recipient ATA and as part of the signed message.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wrapped_mint,
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
    ctx: Context<MintWrapped>,
    message_id: [u8; 32],
    normalized_amount: u128,
    source_chain_id: u64,
    _source_token: [u8; 20],
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

    let mint_amount = denormalize(normalized_amount, ctx.accounts.wrapped_token_config.decimals)?;
    require!(mint_amount > 0, BridgeError::ZeroAmount);

    let bump = ctx.bumps.mint_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[b"mint_authority", &[bump]]];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        mint_amount,
    )?;

    emit!(MintExecuted {
        message_id,
        recipient: ctx.accounts.recipient.key(),
        wrapped_mint: ctx.accounts.wrapped_mint.key(),
        amount: mint_amount,
    });

    Ok(())
}
