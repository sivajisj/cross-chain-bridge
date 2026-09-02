use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

use crate::error::BridgeError;

// Fixed layout of a single-signature Ed25519Program instruction, as built
// by @solana/web3.js's Ed25519Program.createInstructionWithPublicKey():
//   [0]      num_signatures (u8, always 1 here)
//   [1]      padding (u8)
//   [2..16]  Ed25519SignatureOffsets (7 x u16, little-endian)
//   [16..48] public key (32 bytes)
//   [48..112] signature (64 bytes)
//   [112..]  message bytes
const HEADER_LEN: usize = 2;
const OFFSETS_LEN: usize = 14;
const PUBKEY_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;
const DATA_START: usize = HEADER_LEN + OFFSETS_LEN; // 16
const PUBKEY_START: usize = DATA_START; // 16
const SIGNATURE_START: usize = PUBKEY_START + PUBKEY_LEN; // 48
const MESSAGE_START: usize = SIGNATURE_START + SIGNATURE_LEN; // 112

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let bytes: [u8; 2] = data
        .get(offset..offset + 2)
        .ok_or(BridgeError::InvalidEd25519Instruction)?
        .try_into()
        .map_err(|_| error!(BridgeError::InvalidEd25519Instruction))?;
    Ok(u16::from_le_bytes(bytes))
}

// Parses one Ed25519Program instruction that must (a) be self-referential
// -- signature, public key and message all live inside the same
// instruction, at instruction index `expected_ix_index` -- and (b) carry
// exactly one signature. The native Ed25519 program has already checked
// the signature is cryptographically valid over (pubkey, message) by the
// time this program executes; here we only need to confirm the pubkey and
// message are the ones we expect.
fn parse_self_referential_ed25519_ix(
    data: &[u8],
    expected_ix_index: u16,
) -> Result<(Pubkey, Vec<u8>)> {
    require!(
        data.len() >= MESSAGE_START,
        BridgeError::InvalidEd25519Instruction
    );
    require_eq!(
        data[0], 1u8,
        BridgeError::InvalidEd25519Instruction
    );

    let signature_offset = read_u16(data, 2)?;
    let signature_ix_index = read_u16(data, 4)?;
    let pubkey_offset = read_u16(data, 6)?;
    let pubkey_ix_index = read_u16(data, 8)?;
    let message_offset = read_u16(data, 10)?;
    let message_size = read_u16(data, 12)?;
    let message_ix_index = read_u16(data, 14)?;

    require!(
        signature_offset as usize == SIGNATURE_START
            && pubkey_offset as usize == PUBKEY_START
            && message_offset as usize == MESSAGE_START
            && signature_ix_index == expected_ix_index
            && pubkey_ix_index == expected_ix_index
            && message_ix_index == expected_ix_index,
        BridgeError::InvalidEd25519Instruction
    );
    require_eq!(
        data.len(),
        MESSAGE_START + message_size as usize,
        BridgeError::InvalidEd25519Instruction
    );

    let pubkey_bytes: [u8; 32] = data[PUBKEY_START..PUBKEY_START + PUBKEY_LEN]
        .try_into()
        .map_err(|_| error!(BridgeError::InvalidEd25519Instruction))?;
    let message = data[MESSAGE_START..].to_vec();

    Ok((Pubkey::from(pubkey_bytes), message))
}

/// Walks backwards from the current instruction over the `threshold`
/// instructions immediately preceding it in the same transaction. Each
/// must be a native Ed25519Program signature check, self-referential, over
/// exactly `expected_message`, signed by a distinct pubkey drawn from
/// `validators`. Mirrors the EVM side's EIP-712 threshold verification,
/// just with ed25519 sysvar introspection standing in for ecrecover.
pub fn verify_threshold_signatures<'info>(
    instructions_sysvar: &AccountInfo<'info>,
    validators: &[Pubkey; 5],
    threshold: u8,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    let threshold = threshold as u16;
    require!(
        current_index >= threshold,
        BridgeError::InsufficientSignatures
    );

    let mut used: Vec<Pubkey> = Vec::with_capacity(threshold as usize);

    for offset in 1..=threshold {
        let ix_index = current_index - offset;
        let ix = load_instruction_at_checked(ix_index as usize, instructions_sysvar)?;

        require_keys_eq!(
            ix.program_id,
            ed25519_program::ID,
            BridgeError::InvalidEd25519Instruction
        );

        let (pubkey, message) = parse_self_referential_ed25519_ix(&ix.data, ix_index)?;

        require!(
            message.as_slice() == expected_message,
            BridgeError::SignedMessageMismatch
        );
        require!(
            validators.contains(&pubkey),
            BridgeError::UnknownValidator
        );
        require!(!used.contains(&pubkey), BridgeError::DuplicateSigner);
        used.push(pubkey);
    }

    Ok(())
}
