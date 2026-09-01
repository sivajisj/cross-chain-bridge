// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

// ─────────────────────────────────────────────────────────────────────────────
// BridgeDest — Phase 2
//
// Trust model: instead of trusting one owner key to authorize every mint,
// we require a configurable threshold of known validators to co-sign each
// mint request using EIP-712 typed signatures.
//
// Security properties:
//   - One compromised validator key cannot mint anything (threshold > 1)
//   - A stolen signature cannot be replayed (messageId is a one-time nonce)
//   - A signature for chain A cannot be used on chain B (domain separator
//     binds to chainId and verifyingContract address)
//   - A signature for amount X cannot authorize amount X+1 (typed message
//     binds every field)
// ─────────────────────────────────────────────────────────────────────────────
contract BridgeDest is ERC20, Ownable, ReentrancyGuard, Pausable, EIP712 {

    using ECDSA for bytes32;

    // ── EIP-712 type hash ───────────────────────────────────────────────────
    // keccak256 of the canonical type string. Must match exactly what the
    // off-chain signers encode. Any field change here requires updating
    // the signer code too.
    bytes32 public constant MINT_TYPEHASH = keccak256(
        "MintRequest(bytes32 messageId,address recipient,uint256 amount,uint256 sourceChainId,uint256 destChainId)"
    );

    // ── Validator set ───────────────────────────────────────────────────────
    mapping(address => bool) public isValidator;
    address[] public validators;
    uint256 public threshold; // minimum signatures required

    // ── Replay protection ────────────────────────────────────────────────────
    // Once a messageId is processed it can never be processed again,
    // regardless of how many signatures are presented.
    mapping(bytes32 => bool) public processedNonces;

    // ── Stats ───────────────────────────────────────────────────────────────
    uint256 public totalMinted;
    uint256 public totalBurned;

    // ── Events ───────────────────────────────────────────────────────────────
    event TokensMinted(address indexed recipient, uint256 amount, bytes32 messageId);
    event TokensBurned(address indexed user, uint256 amount);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // ── Constructor ──────────────────────────────────────────────────────────
    // EIP712 constructor takes (name, version) — these form part of the
    // domain separator that makes signatures chain-and-contract specific.
    constructor(
        address[] memory _initialValidators,
        uint256 _threshold
    )
        ERC20("Wrapped Bridge Token", "wBRT")
        Ownable(msg.sender)
        EIP712("CrossChainBridge", "1")
    {
        require(_initialValidators.length >= _threshold, "Not enough validators for threshold");
        require(_threshold > 0, "Threshold must be > 0");

        for (uint256 i = 0; i < _initialValidators.length; i++) {
            address v = _initialValidators[i];
            require(v != address(0), "Invalid validator address");
            require(!isValidator[v], "Duplicate validator");
            isValidator[v] = true;
            validators.push(v);
            emit ValidatorAdded(v);
        }
        threshold = _threshold;
    }

    // ── Core mint function ──────────────────────────────────────────────────
    // Anyone can call this — the security comes from the signature
    // verification, not from access control on the caller.
    //
    // Parameters:
    //   recipient     — who receives the wrapped tokens
    //   amount        — how many tokens to mint (wei)
    //   messageId     — deterministic ID from Phase 1 (also the nonce)
    //   sourceChainId — e.g. 11155111 (Sepolia)
    //   signatures    — array of EIP-712 signatures from validators
    function mint(
        address recipient,
        uint256 amount,
        bytes32 messageId,
        uint256 sourceChainId,
        bytes[] calldata signatures
    )
        external
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");
        require(!processedNonces[messageId], "Message already processed");
        require(signatures.length >= threshold, "Not enough signatures");

        // Reconstruct the EIP-712 digest — this is what each validator
        // signed. If any parameter differs from what was signed, the
        // recovered address will not match any validator.
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(
                MINT_TYPEHASH,
                messageId,
                recipient,
                amount,
                sourceChainId,
                block.chainid // destination chain ID from EVM, not a parameter
            ))
        );

        // Count valid, unique validator signatures.
        // We track seen signers to prevent one validator submitting
        // the same signature twice to meet the threshold alone.
        address[] memory seen = new address[](signatures.length);
        uint256 validCount = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = digest.recover(signatures[i]);

            // Must be a known validator
            if (!isValidator[signer]) continue;

            // Must not have signed already in this call (duplicate protection)
            bool duplicate = false;
            for (uint256 j = 0; j < validCount; j++) {
                if (seen[j] == signer) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;

            seen[validCount] = signer;
            validCount++;

            // Short-circuit: stop checking once threshold is met
            if (validCount >= threshold) break;
        }

        require(validCount >= threshold, "Insufficient valid signatures");

        // Mark processed BEFORE minting (CEI pattern)
        processedNonces[messageId] = true;
        totalMinted += amount;

        _mint(recipient, amount);
        emit TokensMinted(recipient, amount, messageId);
    }

    // ── Burn ────────────────────────────────────────────────────────────────
    function burn(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        totalBurned += amount;
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }

    // ── Validator management (owner only) ───────────────────────────────────
    function addValidator(address validator) external onlyOwner {
        require(validator != address(0), "Invalid address");
        require(!isValidator[validator], "Already a validator");
        isValidator[validator] = true;
        validators.push(validator);
        emit ValidatorAdded(validator);
    }

    function removeValidator(address validator) external onlyOwner {
        require(isValidator[validator], "Not a validator");
        require(validators.length - 1 >= threshold, "Would fall below threshold");
        isValidator[validator] = false;

        // Remove from array (order not important)
        for (uint256 i = 0; i < validators.length; i++) {
            if (validators[i] == validator) {
                validators[i] = validators[validators.length - 1];
                validators.pop();
                break;
            }
        }
        emit ValidatorRemoved(validator);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0, "Threshold must be > 0");
        require(newThreshold <= validators.length, "Threshold exceeds validator count");
        emit ThresholdUpdated(threshold, newThreshold);
        threshold = newThreshold;
    }

    // ── View helpers ─────────────────────────────────────────────────────────
    function getValidators() external view returns (address[] memory) {
        return validators;
    }

    function validatorCount() external view returns (uint256) {
        return validators.length;
    }

    // ── Emergency controls ───────────────────────────────────────────────────
    function pauseBridge() external onlyOwner { _pause(); }
    function unpauseBridge() external onlyOwner { _unpause(); }

    // ── Expose domain separator for off-chain signers ────────────────────────
    // Off-chain code needs this to construct the correct EIP-712 digest
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}