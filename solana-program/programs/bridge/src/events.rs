use anchor_lang::prelude::*;

#[event]
pub struct LockEvent {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub dest_chain_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct BurnEvent {
    pub user: Pubkey,
    pub wrapped_mint: Pubkey,
    pub source_token: [u8; 20],
    pub source_chain_id: u64,
    pub amount: u64,
    pub recipient_evm: [u8; 20],
    pub dest_chain_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct MintExecuted {
    pub message_id: [u8; 32],
    pub recipient: Pubkey,
    pub wrapped_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct UnlockExecuted {
    pub message_id: [u8; 32],
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}
