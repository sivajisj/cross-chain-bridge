use anchor_lang::prelude::*;

#[error_code]
pub enum BridgeError {
    #[msg("Bridge is paused")]
    Paused,
    #[msg("Threshold must be between 1 and 5")]
    InvalidThreshold,
    #[msg("Token is not enabled for locking")]
    TokenDisabled,
    #[msg("Amount is outside the configured min/max range")]
    AmountOutOfRange,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough valid validator signatures to reach threshold")]
    InsufficientSignatures,
    #[msg("A validator pubkey was used more than once in this signature set")]
    DuplicateSigner,
    #[msg("An accompanying instruction is not a valid Ed25519Program signature verification")]
    InvalidEd25519Instruction,
    #[msg("Signed message does not match the expected mint/unlock request")]
    SignedMessageMismatch,
    #[msg("Signing pubkey is not a registered validator")]
    UnknownValidator,
    #[msg("Normalized amount overflowed when denormalizing to native decimals")]
    AmountOverflow,
}
