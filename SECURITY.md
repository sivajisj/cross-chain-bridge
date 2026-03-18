# Security & Risk Analysis

## Architecture overview

This bridge uses a lock-and-mint pattern across two EVM chains:
- **Source chain (Ethereum Sepolia)**: Locks real ERC-20 tokens
- **Destination chain (Polygon Amoy)**: Mints wrapped tokens 1:1
- **Relayer**: Off-chain Node.js service connecting both chains

---

## Risk register

### R1 — Relayer compromise (HIGH)
**Description**: If the relayer private key is stolen, attacker can mint unlimited wBRT on Polygon without locking real tokens.

**Mitigation**:
- Relayer wallet holds no user funds — only minting rights
- `onlyOwner` on `mint()` limits blast radius to minting only
- Implement multi-sig ownership (Gnosis Safe) for production
- Rotate relayer keys regularly, store in HSM or AWS KMS

---

### R2 — Reentrancy attack (MEDIUM → mitigated)
**Description**: Malicious ERC-20 with callback could re-enter `lockTokens` before state updates.

**Mitigation**:
- `ReentrancyGuard` from OpenZeppelin applied to all state-changing functions
- CEI (Checks-Effects-Interactions) pattern enforced — state updates before external calls

---

### R3 — Replay attack (HIGH → mitigated)
**Description**: Relayer crash and restart could process same `TokenLocked` event twice, minting double wBRT.

**Mitigation**:
- Deterministic nonce derived from `keccak256(txHash)` — same event always produces same nonce
- `processedNonces` mapping on both contracts permanently blocks reuse
- In-memory `processedTxs` Set as first line of defence in relayer

---

### R4 — Relayer downtime (MEDIUM)
**Description**: If relayer goes offline, user tokens are locked on Ethereum with no wBRT minted.

**Mitigation**:
- Startup catch-up: relayer queries past events on boot
- Store last processed block in MongoDB for full recovery
- Run multiple relayer instances with leader election
- User-facing timeout with clear status in UI

---

### R5 — Smart contract bug (HIGH)
**Description**: Undiscovered vulnerability in bridge contracts could drain locked funds.

**Mitigation**:
- Full test coverage with Hardhat
- OpenZeppelin battle-tested base contracts
- Professional audit before mainnet deployment
- `Pausable` emergency stop — owner can freeze bridge instantly
- Bridge deposit limit: 1,000,000 tokens per transaction

---

### R6 — Chain reorganisation (LOW)
**Description**: Shallow reorg on Ethereum could invalidate a `TokenLocked` event the relayer already processed, causing wBRT to exist without backing.

**Mitigation**:
- Wait for minimum 12 block confirmations before processing (1 Ethereum epoch)
- Monitor for reorgs and implement rollback logic for production

---

### R7 — Oracle / price manipulation (OUT OF SCOPE)
**Description**: This bridge is 1:1 — no price oracle is used. Not applicable for this implementation.

---

## Security checklist

- [x] ReentrancyGuard on all state-changing functions
- [x] CEI pattern enforced
- [x] Nonce-based replay protection on both chains
- [x] Pausable emergency stop mechanism
- [x] onlyOwner access control on mint/unlock
- [x] Input validation on all functions
- [x] Bridge deposit limits
- [ ] Multi-sig ownership (Gnosis Safe) — production requirement
- [ ] Professional smart contract audit — production requirement
- [ ] Block confirmation delay — production requirement
- [ ] HSM key storage for relayer — production requirement

---

## Incident response

If a vulnerability is discovered:
1. Call `pauseBridge()` on both contracts immediately
2. Investigate scope of exploit
3. Deploy patched contracts
4. Verify all locked funds are accounted for
5. Resume with `unpauseBridge()` after verification
