// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./TokenRegistry.sol";

// ─────────────────────────────────────────────────────────────────────────────
// BridgeSource — Phase 3
//
// Handles the source-chain side of bridging in BOTH directions:
//   Sepolia → Amoy: user calls lockTokens(), relayer calls mint() on Amoy
//   Amoy → Sepolia: user burns wToken on Amoy, relayer calls unlockTokens() here
//
// Multi-token: any token registered in the inherited TokenRegistry can be
// locked/unlocked — the Phase 1/2 single hardcoded token is gone.
// ─────────────────────────────────────────────────────────────────────────────
contract BridgeSource is TokenRegistry, ReentrancyGuard, Pausable, EIP712 {

    using ECDSA for bytes32;

    // Validators sign this structure to authorize releasing tokens back
    // to a user (the Amoy → Sepolia direction).
    bytes32 public constant UNLOCK_TYPEHASH = keccak256(
        "UnlockRequest(bytes32 messageId,address token,address recipient,uint256 normalizedAmount,uint256 sourceChainId,uint256 destChainId)"
    );

    // Validator set (mirrors BridgeDest — both sides need the same validators)
    mapping(address => bool) public isValidator;
    address[] public validators;
    uint256 public threshold;

    // Replay protection for unlocks
    mapping(bytes32 => bool) public processedNonces;

    // Stats per token
    mapping(address => uint256) public totalLocked;
    mapping(address => uint256) public totalUnlocked;

    // Per-user per-token locked balance
    mapping(address => mapping(address => uint256)) public lockedBalances;

    event TokenLocked(
        address indexed user,
        address indexed token,
        uint256 amount,   // raw amount in source token decimals
        uint8   decimals, // source token decimals
        uint256 timestamp
    );

    event TokensUnlocked(
        address indexed user,
        address indexed token,
        uint256 amount,
        bytes32 messageId
    );

    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    constructor(
        address[] memory _validators,
        uint256 _threshold
    ) Ownable(msg.sender) EIP712("CrossChainBridgeSource", "1") {
        require(_validators.length >= _threshold, "Not enough validators");
        require(_threshold > 0, "Threshold must be > 0");

        for (uint256 i = 0; i < _validators.length; i++) {
            address v = _validators[i];
            require(v != address(0), "Invalid validator");
            require(!isValidator[v], "Duplicate validator");
            isValidator[v] = true;
            validators.push(v);
            emit ValidatorAdded(v);
        }
        threshold = _threshold;
    }

    // ── Lock tokens (Sepolia → Amoy direction) ───────────────────────────────
    function lockTokens(
        address token,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        TokenConfig memory cfg = tokenConfigs[token];
        require(cfg.enabled, "Token not supported");
        require(amount >= cfg.minAmount, "Amount below minimum");
        require(amount <= cfg.maxAmount, "Amount exceeds maximum");

        lockedBalances[msg.sender][token] += amount;
        totalLocked[token] += amount;

        bool success = IERC20(token).transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");

        emit TokenLocked(msg.sender, token, amount, cfg.decimals, block.timestamp);
    }

    // ── Unlock tokens (Amoy → Sepolia direction) ─────────────────────────────
    // normalizedAmount is in 18-decimal units — converted back to source
    // decimals before releasing.
    function unlockTokens(
        address token,
        address recipient,
        uint256 normalizedAmount,
        bytes32 messageId,
        uint256 sourceChainId,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        require(!processedNonces[messageId], "Already processed");
        require(signatures.length >= threshold, "Not enough signatures");

        TokenConfig memory cfg = tokenConfigs[token];
        require(cfg.enabled, "Token not supported");

        uint256 amount = denormalize(normalizedAmount, cfg.decimals);
        require(amount > 0, "Denormalized amount is zero");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            UNLOCK_TYPEHASH,
            messageId,
            token,
            recipient,
            normalizedAmount,
            sourceChainId,
            block.chainid
        )));

        _verifySignatures(digest, signatures);

        processedNonces[messageId] = true;
        lockedBalances[recipient][token] -= amount;
        totalUnlocked[token] += amount;

        bool success = IERC20(token).transfer(recipient, amount);
        require(success, "Transfer failed");

        emit TokensUnlocked(recipient, token, amount, messageId);
    }

    function _verifySignatures(bytes32 digest, bytes[] calldata signatures) internal view {
        address[] memory seen = new address[](signatures.length);
        uint256 validCount = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = digest.recover(signatures[i]);
            if (!isValidator[signer]) continue;

            bool duplicate = false;
            for (uint256 j = 0; j < validCount; j++) {
                if (seen[j] == signer) { duplicate = true; break; }
            }
            if (duplicate) continue;

            seen[validCount] = signer;
            validCount++;
            if (validCount >= threshold) break;
        }
        require(validCount >= threshold, "Insufficient valid signatures");
    }

    function addValidator(address v) external onlyOwner {
        require(v != address(0) && !isValidator[v], "Invalid");
        isValidator[v] = true;
        validators.push(v);
        emit ValidatorAdded(v);
    }

    function removeValidator(address v) external onlyOwner {
        require(isValidator[v], "Not a validator");
        require(validators.length - 1 >= threshold, "Below threshold");
        isValidator[v] = false;
        for (uint256 i = 0; i < validators.length; i++) {
            if (validators[i] == v) {
                validators[i] = validators[validators.length - 1];
                validators.pop();
                break;
            }
        }
        emit ValidatorRemoved(v);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0, "Threshold must be > 0");
        require(newThreshold <= validators.length, "Threshold exceeds validator count");
        threshold = newThreshold;
    }

    function pauseBridge()   external onlyOwner { _pause(); }
    function unpauseBridge() external onlyOwner { _unpause(); }

    function getValidators() external view returns (address[] memory) {
        return validators;
    }
}
