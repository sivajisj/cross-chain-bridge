# Security Model

> This is a production-oriented architecture prototype. It has not been
> professionally audited and should not be used with real mainnet funds.

## Trust Model

### Validator Set
- 5 independent validators, threshold of 3 required to authorize any mint or unlock
- A single compromised validator key cannot mint tokens or release locked funds
- Two simultaneously compromised validators cannot either (below threshold)
- Three or more compromised validators (≥ threshold) can authorize fraudulent mints

### Owner
- The contract owner can add/remove validators, update the threshold, and
  register/enable/disable tokens
- The owner cannot mint tokens or unlock funds directly (validators control that)
- Owner key compromise allows validator set and token registry manipulation
  but not immediate fund theft

## Threat Model

### Replay Attacks
- **Mitigated**: every messageId is a one-time nonce stored in `processedNonces`
- A message processed on Amoy cannot be replayed on Sepolia (different messageIds,
  since the messageId is derived from the source chain ID, tx hash, and log index)
- A message from one bridge deployment cannot be replayed on another (EIP-712
  domain separator binds to `verifyingContract` address and `chainId`)

### Signature Attacks
- **Mitigated**: EIP-712 typed data binding — every field (token, recipient,
  amount, chainIds, bridge address) is committed in the signed digest
- Changing any field after signing produces a different digest; signatures fail
- Duplicate signer protection: same address counted only once per mint/unlock call

### Validator Compromise
- **Partially mitigated**: threshold model requires ≥3 of 5 validators
- **Residual risk**: if 3+ validators are compromised simultaneously, attackers
  can mint arbitrary tokens or unlock arbitrary escrowed funds. Mitigation:
  validators should run on separate infrastructure, ideally with hardware
  signing keys (HSM)

### Relayer Compromise
- **Low impact**: the relayer submits transactions but cannot authorize mints
  or unlocks alone — it holds no validator key by design
- A compromised relayer can delay or censor messages (liveness attack) but
  cannot steal funds or mint tokens
- **Residual risk**: relayer censorship — no automated failover in this
  architecture; a stalled relayer requires manual restart

### Reorg and Finality Risks
- **Mitigated**: configurable `CONFIRMATIONS_REQUIRED` (default 5) before a
  lock or burn event is considered finalized. Shallow reorgs (< confirmations)
  are handled — the event is simply re-detected as CONFIRMING, not finalized.
- **Residual risk**: deep reorgs (> confirmations) could allow double-spend.
  For production, increase confirmations for high-value transfers.

### Token Risks
- **Mitigated**: token registry — only whitelisted tokens can be locked, minted,
  or burned; `enableToken`/`disableToken` let the owner pull a single token
  without pausing the whole bridge
- Non-standard ERC-20s (fee-on-transfer, rebasing) are not supported and
  will produce incorrect accounting if registered — `lockTokens` assumes the
  amount transferred in equals the amount requested. Only standard tokens
  should be registered.
- Decimal normalization prevents value loss for tokens with ≤ 18 decimals
  (verified by round-trip fuzz tests in `test/Fuzz.test.js`). Tokens with
  more than 18 decimals are rejected at registration time.

### Operational Risks
- **Bridge pause**: owner can pause all operations via `pauseBridge()` on
  either contract independently
- **Token disable**: owner can disable a specific token without pausing the
  whole bridge
- **Emergency recovery**: no upgrade mechanism — redeployment required for
  critical fixes. This is intentional (no proxy upgrade attack surface) but
  means emergency response requires a coordinated redeployment and a
  validator/owner re-signoff.

## Slither Findings

Full raw output is in `slither-report.txt` (regenerate with
`python3 -m slither . --exclude-dependencies`). Slither found no high or
medium severity issues. All findings are informational/optimization-level:

| Finding | Severity | Accepted? | Reason |
|---|---|---|---|
| `shadowing-local`: `WrappedToken` constructor params `name`/`symbol` shadow `ERC20.name()`/`symbol()` | Informational | Accepted | Standard OpenZeppelin constructor pattern — the params are consumed by `ERC20(name, symbol)` in the same statement and never referenced again; no functional ambiguity. |
| `events-maths`: `setThreshold` on both `BridgeDest` and `BridgeSource` changes `threshold` without emitting an event | Low | Accepted, tracked as a follow-up | Off-chain monitoring currently reads `threshold()` directly rather than via events; adding a `ThresholdUpdated` event is a one-line, backwards-compatible fix worth picking up before a real deployment. |
| `pragma`: 6 different Solidity version constraints in the dependency tree | Informational | Accepted | Entirely from OpenZeppelin's own imports (`^0.8.20` through `>=0.4.16` on old interfaces); our own contracts all pin `^0.8.28` consistently. Not something we control without vendoring OZ. |
| `costly-loop`: `validators.pop()` inside the removal loop in `removeValidator` (both contracts) | Informational | Accepted | The loop runs at most `validators.length` times (≤ a handful of validators by design) and `pop()` executes exactly once per call, on the matched index, not per iteration — this is Slither flagging a state-mutating call inside a loop body in general, not an actual O(n) cost blowup here. |

## Known Limitations

1. No upgrade mechanism — contract bugs require redeployment
2. Validator set is managed on-chain by one owner key — HSM recommended for production
3. No fee mechanism — relayer operates at cost with no on-chain compensation
4. Single relayer instance — liveness depends on the relayer staying online
5. No MEV protection on unlock/mint transactions
6. Token registry managed centrally — no decentralized governance
7. `setThreshold` does not emit an event (see Slither findings above)
8. Not audited — for educational and portfolio demonstration purposes only

## Test Coverage

Statement coverage across all bridge contracts is ~97% (see `coverage/index.html`,
generated via `npx hardhat coverage`). The remaining gaps are:
- `BridgeDest.unpauseBridge()` — trivial one-liner, exercised on `BridgeSource`
  but not separately on `BridgeDest`
- The `decimals_ > 18` branch of `TokenRegistry.normalize`/`denormalize` —
  unreachable in practice, since `registerToken` already rejects any token
  with more than 18 decimals at registration time

## Emergency Procedures

1. **Pause the bridge**: `bridgeSource.pauseBridge()` and `bridgeDest.pauseBridge()`
2. **Disable a specific token**: `bridgeSource.disableToken(tokenAddress)` and
   `bridgeDest.disableToken(tokenAddress)`
3. **Remove a compromised validator**: `bridgeDest.removeValidator(address)` /
   `bridgeSource.removeValidator(address)` (only if remaining validators ≥ threshold)
4. **Stop the relayer**: `Ctrl+C` — it shuts down cleanly and resumes from
   the last scanned block per chain on restart. No funds are at risk when
   the relayer is stopped; it holds no validator key and cannot move funds itself.
