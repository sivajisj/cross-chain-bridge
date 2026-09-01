// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// ─────────────────────────────────────────────────────────────────────────────
// WrappedToken — Phase 3
//
// A generic wrapped ERC-20 deployed once per bridged source token.
// The bridge contract (BridgeDest) is the owner and the only entity
// that can mint or burn. Users interact with the bridge, not directly
// with this contract.
//
// Decimals are set at deploy time to match the source token, so a user
// holding wUSDC sees 6 decimal places just like they would holding USDC.
// ─────────────────────────────────────────────────────────────────────────────
contract WrappedToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_
    ) ERC20(name, symbol) Ownable(msg.sender) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
