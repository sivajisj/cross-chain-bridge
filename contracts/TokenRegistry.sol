// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

// ─────────────────────────────────────────────────────────────────────────────
// TokenRegistry — Phase 3
//
// Stores which tokens are allowed to be bridged and their configuration.
// Both BridgeSource and BridgeDest inherit from this so they share
// the same token management interface and storage layout.
//
// Key design decisions:
//   - decimals stored on-chain so the bridge never has to call
//     token.decimals() at bridge time (saves gas, avoids non-standard tokens)
//   - maxAmount per token prevents one user from draining the whole bridge
//   - enabled flag lets the owner pause a specific token without
//     pausing the whole bridge
// ─────────────────────────────────────────────────────────────────────────────
abstract contract TokenRegistry is Ownable {

    struct TokenConfig {
        bool    enabled;      // can this token be bridged right now?
        uint8   decimals;     // source token decimals (6, 8, or 18)
        uint256 maxAmount;    // max per-transaction amount (in source decimals)
        uint256 minAmount;    // min per-transaction amount (in source decimals)
    }

    // sourceToken address => config
    mapping(address => TokenConfig) public tokenConfigs;
    address[] public registeredTokens;

    event TokenRegistered(address indexed token, uint8 decimals, uint256 minAmount, uint256 maxAmount);
    event TokenEnabled(address indexed token);
    event TokenDisabled(address indexed token);
    event TokenLimitsUpdated(address indexed token, uint256 minAmount, uint256 maxAmount);

    // Register a new token. Can only be called by owner (bridge deployer).
    // decimals_ must match the actual token's decimals — this is not
    // validated on-chain, so the deployer must get it right.
    function registerToken(
        address token,
        uint8   decimals_,
        uint256 minAmount,
        uint256 maxAmount
    ) external onlyOwner {
        _registerToken(token, decimals_, minAmount, maxAmount);
    }

    // Internal so subclasses (e.g. BridgeDest, which also deploys a wrapped
    // token per registration) can register without an external self-call —
    // an external `this.registerToken(...)` would run with msg.sender ==
    // the contract itself and fail the onlyOwner check.
    function _registerToken(
        address token,
        uint8   decimals_,
        uint256 minAmount,
        uint256 maxAmount
    ) internal {
        require(token != address(0), "Invalid token address");
        require(!tokenConfigs[token].enabled, "Token already registered");
        require(maxAmount > minAmount, "maxAmount must exceed minAmount");
        require(decimals_ <= 18, "Decimals must be <= 18");

        tokenConfigs[token] = TokenConfig({
            enabled:   true,
            decimals:  decimals_,
            maxAmount: maxAmount,
            minAmount: minAmount
        });
        registeredTokens.push(token);

        emit TokenRegistered(token, decimals_, minAmount, maxAmount);
    }

    function enableToken(address token) external onlyOwner {
        require(tokenConfigs[token].decimals > 0, "Token not registered");
        tokenConfigs[token].enabled = true;
        emit TokenEnabled(token);
    }

    function disableToken(address token) external onlyOwner {
        require(tokenConfigs[token].enabled, "Token not enabled");
        tokenConfigs[token].enabled = false;
        emit TokenDisabled(token);
    }

    function setTokenLimits(
        address token,
        uint256 minAmount,
        uint256 maxAmount
    ) external onlyOwner {
        require(tokenConfigs[token].decimals > 0, "Token not registered");
        require(maxAmount > minAmount, "maxAmount must exceed minAmount");
        tokenConfigs[token].minAmount = minAmount;
        tokenConfigs[token].maxAmount = maxAmount;
        emit TokenLimitsUpdated(token, minAmount, maxAmount);
    }

    function isTokenEnabled(address token) external view returns (bool) {
        return tokenConfigs[token].enabled;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return tokenConfigs[token];
    }

    function getRegisteredTokens() external view returns (address[] memory) {
        return registeredTokens;
    }

    // Shared decimal-normalization math — every amount that crosses the
    // bridge is expressed as an 18-decimal "normalized" value in transit,
    // regardless of the source token's native decimals.
    function normalize(uint256 amount, uint8 decimals_) public pure returns (uint256) {
        if (decimals_ == 18) return amount;
        if (decimals_ < 18)  return amount * (10 ** (18 - decimals_));
        return amount / (10 ** (decimals_ - 18)); // decimals_ > 18 (rare)
    }

    function denormalize(uint256 normalized, uint8 decimals_) public pure returns (uint256) {
        if (decimals_ == 18) return normalized;
        if (decimals_ < 18)  return normalized / (10 ** (18 - decimals_));
        return normalized * (10 ** (decimals_ - 18));
    }
}
