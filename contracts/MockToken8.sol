// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// 8-decimal mock token (mirrors WBTC) used only in tests to exercise
// decimal normalization with a non-18-decimal token.
contract MockToken8 is ERC20 {
    constructor() ERC20("Mock WBTC", "mWBTC") {
        _mint(msg.sender, 1_000 * 10 ** decimals());
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
