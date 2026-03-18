// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract BridgeDest is ERC20, Ownable, ReentrancyGuard, Pausable {

    // Replay protection on destination side too
    mapping(bytes32 => bool) public processedNonces;

    uint256 public totalMinted;
    uint256 public totalBurned;

    event TokensMinted(address indexed user, uint256 amount, bytes32 nonce);
    event TokensBurned(address indexed user, uint256 amount);

    constructor() ERC20("Wrapped Bridge Token", "wBRT") Ownable(msg.sender) {}

    function mint(address user, uint256 amount, bytes32 nonce)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Amount must be > 0");
        require(!processedNonces[nonce], "Nonce already processed");

        processedNonces[nonce] = true;
        totalMinted += amount;

        _mint(user, amount);
        emit TokensMinted(user, amount, nonce);
    }

    function burn(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Amount must be > 0");
        totalBurned += amount;
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }

    function pauseBridge() external onlyOwner { _pause(); }
    function unpauseBridge() external onlyOwner { _unpause(); }
}