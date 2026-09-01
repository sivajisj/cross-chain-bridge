// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./TokenRegistry.sol";
import "./WrappedToken.sol";

// ─────────────────────────────────────────────────────────────────────────────
// BridgeDest — Phase 3
//
// Handles the destination-chain side of bridging in BOTH directions:
//   Sepolia → Amoy: relayer calls mint() with threshold signatures
//   Amoy → Sepolia: user calls burn() here, relayer unlocks on Sepolia
//
// For each source token registered, BridgeDest deploys one WrappedToken
// contract. normalizedAmount (18 decimals) is used in transit; the
// wrapped token is minted/burned in source-matching decimals.
// ─────────────────────────────────────────────────────────────────────────────
contract BridgeDest is TokenRegistry, ReentrancyGuard, Pausable, EIP712 {

    using ECDSA for bytes32;

    bytes32 public constant MINT_TYPEHASH = keccak256(
        "MintRequest(bytes32 messageId,address sourceToken,address recipient,uint256 normalizedAmount,uint256 sourceChainId,uint256 destChainId)"
    );

    mapping(address => bool) public isValidator;
    address[] public validators;
    uint256 public threshold;

    // sourceToken → wrappedToken
    mapping(address => address) public wrappedTokens;

    mapping(bytes32 => bool) public processedNonces;

    mapping(address => uint256) public totalMinted;
    mapping(address => uint256) public totalBurned;

    event TokensMinted(
        address indexed recipient,
        address indexed sourceToken,
        address indexed wrappedToken,
        uint256 amount,
        bytes32 messageId
    );
    event TokensBurned(
        address indexed user,
        address indexed sourceToken,
        address indexed wrappedToken,
        uint256 amount
    );
    event WrappedTokenDeployed(address indexed sourceToken, address indexed wrappedToken);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    constructor(
        address[] memory _validators,
        uint256 _threshold
    ) Ownable(msg.sender) EIP712("CrossChainBridge", "1") {
        require(_validators.length >= _threshold, "Not enough validators");
        require(_threshold > 0, "Threshold must be > 0");

        for (uint256 i = 0; i < _validators.length; i++) {
            address v = _validators[i];
            require(v != address(0) && !isValidator[v], "Invalid validator");
            isValidator[v] = true;
            validators.push(v);
            emit ValidatorAdded(v);
        }
        threshold = _threshold;
    }

    // ── Register a token + deploy its wrapped counterpart ────────────────────
    // Must be called before the token can be bridged. Registers directly via
    // the internal TokenRegistry hook rather than an external self-call —
    // `this.registerToken(...)` would run with msg.sender == this contract
    // and fail the onlyOwner check on the inherited function.
    function registerTokenWithWrapped(
        address sourceToken,
        uint8   decimals_,
        uint256 minAmount,
        uint256 maxAmount,
        string calldata wrappedName,
        string calldata wrappedSymbol
    ) external onlyOwner {
        _registerToken(sourceToken, decimals_, minAmount, maxAmount);

        WrappedToken wToken = new WrappedToken(wrappedName, wrappedSymbol, decimals_);
        wrappedTokens[sourceToken] = address(wToken);

        emit WrappedTokenDeployed(sourceToken, address(wToken));
    }

    // ── Mint (Sepolia → Amoy direction) ──────────────────────────────────────
    function mint(
        address sourceToken,
        address recipient,
        uint256 normalizedAmount,
        bytes32 messageId,
        uint256 sourceChainId,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        require(!processedNonces[messageId], "Already processed");
        require(signatures.length >= threshold, "Not enough signatures");
        require(recipient != address(0), "Invalid recipient");

        TokenConfig memory cfg = tokenConfigs[sourceToken];
        require(cfg.enabled, "Token not supported");

        address wTokenAddr = wrappedTokens[sourceToken];
        require(wTokenAddr != address(0), "No wrapped token deployed");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            MINT_TYPEHASH,
            messageId,
            sourceToken,
            recipient,
            normalizedAmount,
            sourceChainId,
            block.chainid
        )));

        _verifySignatures(digest, signatures);

        uint256 mintAmount = denormalize(normalizedAmount, cfg.decimals);
        require(mintAmount > 0, "Mint amount is zero");

        processedNonces[messageId] = true;
        totalMinted[sourceToken] += mintAmount;

        WrappedToken(wTokenAddr).mint(recipient, mintAmount);

        emit TokensMinted(recipient, sourceToken, wTokenAddr, mintAmount, messageId);
    }

    // ── Burn (Amoy → Sepolia direction) ──────────────────────────────────────
    function burn(
        address sourceToken,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        TokenConfig memory cfg = tokenConfigs[sourceToken];
        require(cfg.enabled, "Token not supported");

        address wTokenAddr = wrappedTokens[sourceToken];
        require(wTokenAddr != address(0), "No wrapped token");

        totalBurned[sourceToken] += amount;
        WrappedToken(wTokenAddr).burn(msg.sender, amount);

        emit TokensBurned(msg.sender, sourceToken, wTokenAddr, amount);
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
