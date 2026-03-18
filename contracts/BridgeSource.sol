// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract BridgeSource is Ownable, ReentrancyGuard, Pausable {
    IERC20 public token;

    // Track locked balances per user
    mapping(address => uint256) public lockedBalances;

    // Replay protection — track processed unlock nonces
    mapping(bytes32 => bool) public processedNonces;

    // Bridge stats
    uint256 public totalLocked;
    uint256 public totalUnlocked;

    event TokenLocked(
        address indexed user,
        uint256 amount,
        uint256 timestamp
    );

    event TokensUnlocked(
        address indexed user,
        uint256 amount,
        bytes32 nonce
    );

    event BridgePaused(address by);
    event BridgeUnpaused(address by);

    constructor(address _token) Ownable(msg.sender) {
        token = IERC20(_token);
    }

    // ── Lock tokens ────────────────────────────────────────────
    // nonReentrant prevents reentrancy attacks
    // whenNotPaused stops all activity during emergencies
    function lockTokens(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Amount must be > 0");
        require(amount <= 1_000_000 ether, "Amount exceeds bridge limit");

        // Effects before interactions (CEI pattern)
        lockedBalances[msg.sender] += amount;
        totalLocked += amount;

        // Interaction last — pull tokens from user
        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");

        emit TokenLocked(msg.sender, amount, block.timestamp);
    }

    // ── Unlock tokens (called by relayer) ─────────────────────
    function unlockTokens(
        address user,
        uint256 amount,
        bytes32 nonce           // unique ID per unlock request
    )
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Amount must be > 0");
        require(lockedBalances[user] >= amount, "Insufficient locked balance");

        // Replay protection — reject if nonce already used
        require(!processedNonces[nonce], "Nonce already processed");

        // Mark nonce as used BEFORE transfer (CEI pattern)
        processedNonces[nonce] = true;
        lockedBalances[user] -= amount;
        totalUnlocked += amount;

        bool success = token.transfer(user, amount);
        require(success, "Transfer failed");

        emit TokensUnlocked(user, amount, nonce);
    }

    // ── Emergency controls ─────────────────────────────────────
    function pauseBridge() external onlyOwner {
        _pause();
        emit BridgePaused(msg.sender);
    }

    function unpauseBridge() external onlyOwner {
        _unpause();
        emit BridgeUnpaused(msg.sender);
    }

    // ── View functions ─────────────────────────────────────────
    function bridgeBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function isNonceProcessed(bytes32 nonce) external view returns (bool) {
        return processedNonces[nonce];
    }
}