# Cross-Chain Token Bridge

A production-grade cross-chain bridge that locks ERC-20 tokens on Ethereum and mints wrapped tokens on Polygon using a lock-and-mint pattern. Built with Solidity, Hardhat, ethers.js, and React.

---

## Architecture

```
User (Ethereum Sepolia)
    │
    │  lockTokens(amount)
    ▼
BridgeSource.sol  ──── emits TokenLocked event ────►  Relayer (Node.js)
(Sepolia)                                                    │
                                                             │  mint(user, amount, nonce)
                                                             ▼
                                                     BridgeDest.sol
                                                     (Polygon Amoy)
                                                             │
                                                             ▼
                                                   User receives wBRT
```

**Key design decisions:**
- `BridgeDest` is itself an ERC-20 — wrapped tokens are natively tradeable on Polygon the moment they're minted
- The `TokenLocked` event is the communication mechanism between chains — no direct cross-chain calls
- Deterministic nonces (`keccak256(txHash)`) prevent replay attacks even across relayer restarts
- `ReentrancyGuard` + CEI pattern on all state-changing functions

---

## Deployed Contracts

### Ethereum Sepolia

| Contract | Address | Explorer |
|---|---|---|
| MockERC20 (BRT) | `0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b` | [View on Etherscan](https://sepolia.etherscan.io/address/0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b#code) |
| BridgeSource | `0xF30f2aB2EC89C5Cff7A31554C8117CD7345dbDc8` | [View on Etherscan](https://sepolia.etherscan.io/address/0xF30f2aB2EC89C5Cff7A31554C8117CD7345dbDc8#code) |

### Polygon Amoy

| Contract | Address | Explorer |
|---|---|---|
| BridgeDest (wBRT) | `0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b` | [View on Polygonscan](https://amoy.polygonscan.com/address/0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b#code) |

> All contracts are verified — source code publicly readable on block explorers.

---

## Project Structure

```
cross-chain-bridge/
├── contracts/
│   ├── MockERC20.sol          # Test ERC-20 token (BRT)
│   ├── BridgeSource.sol       # Locks tokens on Ethereum
│   └── BridgeDest.sol         # Mints wrapped tokens on Polygon
├── scripts/
│   ├── deploy-source.js       # Deploy to Sepolia
│   ├── deploy-dest.js         # Deploy to Polygon Amoy
│   ├── transfer-ownership.js  # Set relayer as BridgeDest owner
│   ├── fund-wallet.js         # Mint test tokens
│   └── manual-mint.js         # Emergency manual mint
├── relayer/
│   ├── relayer.js             # Off-chain event listener + minter
│   ├── abis/                  # Contract ABIs
│   └── .env                   # Relayer environment config
├── frontend/
│   ├── src/
│   │   ├── App.js             # Main dApp component
│   │   ├── config.js          # Contract addresses + RPC URLs
│   │   └── abis/              # Contract ABIs for frontend
│   └── package.json
├── test/
│   └── Bridge.test.js         # 7 tests covering full flow
├── SECURITY.md                # Risk analysis + mitigation plan
├── hardhat.config.js
└── .env                       # Root environment config
```

---

## Prerequisites

- Node.js v18+
- MetaMask browser extension
- Alchemy account (free tier) — [alchemy.com](https://alchemy.com)
- Etherscan API key — [etherscan.io/apis](https://etherscan.io/apis)

---

## Installation

### 1. Clone and install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/cross-chain-bridge.git
cd cross-chain-bridge
npm install
```

### 2. Set up root `.env`

Create `.env` in the project root:

```env
# RPC URLs from Alchemy
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
AMOY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# Deployer wallet private key (never use a wallet with real funds)
PRIVATE_KEY=0x_YOUR_DEPLOYER_PRIVATE_KEY

# Relayer wallet private key (separate wallet from deployer)
RELAYER_PRIVATE_KEY=0x_YOUR_RELAYER_PRIVATE_KEY

# Block explorer API keys (same key works for both via Etherscan V2)
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY
```

> **Never commit `.env` to git.** It is already in `.gitignore`.

### 3. Get testnet funds

| Network | Faucet | Amount needed |
|---|---|---|
| Ethereum Sepolia | [cloud.google.com/web3/faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) | ~0.05 ETH |
| Polygon Amoy | [faucet.polygon.technology](https://faucet.polygon.technology) | ~0.5 MATIC |

Fund both your **deployer wallet** and **relayer wallet**.

---

## Deploy

### Deploy to Sepolia (Ethereum)

```bash
npx hardhat run scripts/deploy-source.js --network sepolia
```

Output:
```
Deploying to Sepolia...
Deployer address: 0x...
Balance: 0.1 ETH
MockERC20 deployed to: 0x...
BridgeSource deployed to: 0x...
Addresses saved to deployed-sepolia.json
```

### Deploy to Polygon Amoy

```bash
npx hardhat run scripts/deploy-dest.js --network amoy
```

Output:
```
Deploying to Polygon Amoy...
BridgeDest deployed to: 0x...
Addresses saved to deployed-amoy.json
```

### Transfer ownership to relayer wallet

The relayer wallet must own `BridgeDest` to call `mint()`. Update `scripts/transfer-ownership.js` with your deployed addresses, then:

```bash
npx hardhat run scripts/transfer-ownership.js --network amoy
```

### Verify contracts on block explorers

```bash
# Verify MockERC20
npx hardhat verify --network sepolia MOCK_TOKEN_ADDRESS

# Verify BridgeSource (pass token address as constructor arg)
npx hardhat verify --network sepolia BRIDGE_SOURCE_ADDRESS "MOCK_TOKEN_ADDRESS"

# Verify BridgeDest
npx hardhat verify --network amoy BRIDGE_DEST_ADDRESS
```

---

## Relayer Setup

The relayer is a Node.js service that listens for `TokenLocked` events on Sepolia and calls `mint()` on Polygon Amoy.

### 1. Install dependencies

```bash
cd relayer
npm install
```

### 2. Set up relayer `.env`

Create `relayer/.env`:

```env
# RPC URLs
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
AMOY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# Relayer wallet — must be owner of BridgeDest
RELAYER_PRIVATE_KEY=0x_YOUR_RELAYER_PRIVATE_KEY

# Deployed contract addresses
BRIDGE_SOURCE_ADDRESS=0xF30f2aB2EC89C5Cff7A31554C8117CD7345dbDc8
BRIDGE_DEST_ADDRESS=0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b
```

### 3. Copy ABIs

```bash
cp ../artifacts/contracts/BridgeSource.sol/BridgeSource.json abis/
cp ../artifacts/contracts/BridgeDest.sol/BridgeDest.json abis/
```

### 4. Start the relayer

```bash
node relayer.js
```

Expected output:
```
Relayer starting...
Relayer wallet: 0x21abDd5D4e1cFe21E3885AC932eAF021ED744A62
Sepolia block: 10469913
Amoy block:    35354304
Checking for past events...
No past events found.
Listening for new TokenLocked events on Sepolia...
```

When a user locks tokens, the relayer prints:
```
── TokenLocked event detected ──────────────────
User:       0x...
Amount:     10.0 BRT
Tx hash:    0x...
Minting wBRT on Polygon Amoy...
Mint confirmed in block: 35356999
Done — user received wBRT on Polygon
```

---

## Frontend Setup

### 1. Install dependencies

```bash
cd frontend
npm install
```

### 2. Update `src/config.js`

```javascript
export const CONFIG = {
  SOURCE_CHAIN: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    rpcUrl: "https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY",
    explorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  DEST_CHAIN: {
    chainId: "0x13882",
    chainName: "Polygon Amoy",
    rpcUrl: "https://polygon-amoy.g.alchemy.com/v2/YOUR_KEY",
    explorer: "https://amoy.polygonscan.com",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  },
  ADDRESSES: {
    mockToken:    "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b",
    bridgeSource: "0xF30f2aB2EC89C5Cff7A31554C8117CD7345dbDc8",
    bridgeDest:   "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b",
  },
};
```

### 3. Copy ABIs

```bash
cp ../artifacts/contracts/BridgeSource.sol/BridgeSource.json src/abis/
cp ../artifacts/contracts/BridgeDest.sol/BridgeDest.json src/abis/
cp ../artifacts/contracts/MockERC20.sol/MockERC20.json src/abis/
```

### 4. Start the frontend

```bash
npm start
```

Opens at `http://localhost:3000`.

**Using the bridge:**
1. Connect MetaMask — switch to Sepolia network
2. Enter amount to bridge
3. Click Bridge — approve two MetaMask transactions (Approve + Lock)
4. Wait 15–30 seconds for relayer to mint wBRT on Polygon
5. wBRT balance updates automatically

---

## Running Tests

```bash
npx hardhat test
```

Expected output:
```
Cross-Chain Bridge
  ✔ locks tokens on source chain
  ✔ relayer mints wrapped tokens on destination chain
  ✔ user can burn wrapped tokens to get real tokens back
  ✔ rejects duplicate nonces
  ✔ blocks operations when paused
  ✔ prevents reentrancy on lockTokens
  ✔ tracks total locked and unlocked stats

7 passing
```

---

## Security Features

| Feature | Implementation |
|---|---|
| Reentrancy protection | `ReentrancyGuard` on all state-changing functions |
| Replay attack prevention | Deterministic nonces via `keccak256(txHash)` |
| Emergency stop | `Pausable` — owner can freeze bridge instantly |
| Access control | `onlyOwner` on `mint()` and `unlockTokens()` |
| CEI pattern | State updates before all external calls |
| Bridge limits | Max 1,000,000 tokens per transaction |

See [SECURITY.md](./SECURITY.md) for full risk analysis and mitigation plan.

---

## JD Concepts Covered

| JD Requirement | Implementation |
|---|---|
| Solidity + smart contracts | `BridgeSource.sol`, `BridgeDest.sol` |
| EVM + Ethereum | Deployed on Sepolia testnet |
| Cross-chain / EVM compatibility | Ethereum → Polygon bridge |
| JavaScript | Relayer service, deploy scripts |
| Event-driven architecture | `TokenLocked` event drives the bridge |
| Consensus / transaction finality | Block confirmation tracking |
| Risk analysis | `SECURITY.md` with 7 risk categories |
| NFT-adjacent (ERC-20) | Full ERC-20 implementation on both sides |
| IPFS / NoSQL | Extendable — MongoDB for relayer state |

---

## Tech Stack

- **Solidity 0.8.20** — Smart contracts
- **Hardhat** — Development + testing framework
- **OpenZeppelin** — `ReentrancyGuard`, `Ownable`, `Pausable`, `ERC20`
- **ethers.js v6** — Blockchain interaction
- **React** — Frontend dApp
- **Alchemy** — RPC provider
- **Node.js** — Relayer service

---

## License

MIT