/* global BigInt */
import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { CONFIG } from "./config";
import BridgeSourceABI from "./abis/BridgeSource.json";
import BridgeDestABI   from "./abis/BridgeDest.json";
import MockERC20ABI    from "./abis/MockERC20.json";
import WrappedTokenABI from "./abis/WrappedToken.json";
import "./App.css";

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmt     = (val, dec = 4) => parseFloat(ethers.formatEther(val)).toFixed(dec);
const short   = (addr) => addr ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : "";
const shortTx = (h)    => h ? `${h.slice(0, 10)}...${h.slice(-8)}` : "";

const STEPS = [
  { key: "wallet",     label: "Wallet connected"       },
  { key: "approve",    label: "Approved token spend"   },
  { key: "lock",       label: "Locked on source chain" },
  { key: "confirming", label: "Waiting confirmations"  },
  { key: "validators", label: "Validators signing"     },
  { key: "minting",    label: "Minting on destination" },
  { key: "completed",  label: "Transfer complete"      },
];

const STATUS_COLOR = {
  DETECTED:   "#f59e0b",
  CONFIRMING: "#3b82f6",
  FINALIZED:  "#8b5cf6",
  SUBMITTED:  "#6366f1",
  COMPLETED:  "#10b981",
  FAILED:     "#ef4444",
  RETRYING:   "#f97316",
};

// ── Tab: Bridge ──────────────────────────────────────────────────────────────
function BridgeTab({ account, provider, chainId }) {
  const [amount,      setAmount]      = useState("");
  const [direction,   setDirection]   = useState("LOCK"); // LOCK or BURN
  const [balances,    setBalances]    = useState({ brt: "0", wbrt: "0" });
  const [steps,       setSteps]       = useState([]);
  const [currentStep, setCurrentStep] = useState(-1);
  const [loading,     setLoading]     = useState(false);
  const [txHash,      setTxHash]      = useState(null);
  const [messageId,   setMessageId]   = useState(null);
  const [msgStatus,   setMsgStatus]   = useState(null);

  const fetchBalances = useCallback(async () => {
    if (!account) return;
    try {
      const sepolia = new ethers.JsonRpcProvider(CONFIG.SOURCE_CHAIN.rpcUrl);
      const amoy    = new ethers.JsonRpcProvider(CONFIG.DEST_CHAIN.rpcUrl);
      const token   = new ethers.Contract(CONFIG.ADDRESSES.mockToken, MockERC20ABI.abi, sepolia);
      const dest    = new ethers.Contract(CONFIG.ADDRESSES.bridgeDest, BridgeDestABI.abi, amoy);

      // BridgeDest itself is no longer an ERC20 as of Phase 3 — each source
      // token gets its own WrappedToken contract, looked up via wrappedTokens().
      const wrappedAddr = await dest.wrappedTokens(CONFIG.ADDRESSES.mockToken);
      const [brt, wbrt] = await Promise.all([
        token.balanceOf(account),
        wrappedAddr === ethers.ZeroAddress
          ? Promise.resolve(0n)
          : new ethers.Contract(wrappedAddr, WrappedTokenABI.abi, amoy).balanceOf(account),
      ]);
      setBalances({ brt: fmt(brt), wbrt: fmt(wbrt) });
    } catch (_) {}
  }, [account]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);
  useEffect(() => {
    if (!account) return;
    const t = setInterval(fetchBalances, 30000);
    return () => clearInterval(t);
  }, [account, fetchBalances]);

  // Poll message status from the API once we have a txHash
  useEffect(() => {
    if (!txHash) return;
    const poll = async () => {
      try {
        const res = await fetch(`${CONFIG.API_URL}/api/messages/tx/${txHash}`);
        if (!res.ok) return;
        const msg = await res.json();
        setMessageId(msg.message_id);
        setMsgStatus(msg.status);
        if (msg.status === "COMPLETED") {
          setCurrentStep(6);
          fetchBalances();
        } else if (msg.status === "FAILED") {
          setCurrentStep(-1);
        } else if (msg.status === "CONFIRMING") {
          setCurrentStep(3);
        } else if (msg.status === "FINALIZED") {
          setCurrentStep(4);
        } else if (msg.status === "SUBMITTED") {
          setCurrentStep(5);
        }
      } catch (_) {}
    };
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [txHash, fetchBalances]);

  const addStep = (key) => {
    setSteps((prev) => [...prev, { key, ts: Date.now() }]);
    const idx = STEPS.findIndex((s) => s.key === key);
    setCurrentStep(idx);
  };

  const onSepolia = chainId === CONFIG.SOURCE_CHAIN.chainId.replace("0x", "");
  const onAmoy    = chainId === CONFIG.DEST_CHAIN.chainId.replace("0x", "");

  const bridge = async () => {
    if (!account || !amount || parseFloat(amount) <= 0 || loading) return;
    setLoading(true);
    setSteps([]);
    setCurrentStep(0);
    setTxHash(null);
    setMessageId(null);
    setMsgStatus(null);

    try {
      const signer = await provider.getSigner();

      if (direction === "LOCK") {
        if (!onSepolia) {
          alert("Please switch MetaMask to Sepolia to bridge tokens.");
          setLoading(false);
          return;
        }
        const parsedAmt = ethers.parseEther(amount);
        addStep("wallet");

        addStep("approve");
        const token = new ethers.Contract(CONFIG.ADDRESSES.mockToken, MockERC20ABI.abi, signer);
        const appTx = await token.approve(CONFIG.ADDRESSES.bridgeSource, parsedAmt);
        await appTx.wait();

        addStep("lock");
        const source = new ethers.Contract(CONFIG.ADDRESSES.bridgeSource, BridgeSourceABI.abi, signer);
        const lockTx = await source.lockTokens(CONFIG.ADDRESSES.mockToken, parsedAmt);
        await lockTx.wait();
        setTxHash(lockTx.hash);
        addStep("confirming");

      } else {
        // BURN direction (Amoy → Sepolia) — no approval step needed, the
        // "approve" entry is skipped so the step list reflects what
        // actually happened on-chain.
        if (!onAmoy) {
          alert("Please switch MetaMask to Polygon Amoy to burn wBRT.");
          setLoading(false);
          return;
        }
        const parsedAmt = ethers.parseEther(amount);
        addStep("wallet");

        addStep("lock"); // reused label context: "Burning on Amoy"
        const dest   = new ethers.Contract(CONFIG.ADDRESSES.bridgeDest, BridgeDestABI.abi, signer);
        const burnTx = await dest.burn(CONFIG.ADDRESSES.mockToken, parsedAmt);
        await burnTx.wait();
        setTxHash(burnTx.hash);
        addStep("confirming");
      }
    } catch (err) {
      console.error(err);
      alert(err.reason || err.message);
    } finally {
      setLoading(false);
    }
  };

  const explorerBase = direction === "LOCK" ? CONFIG.SOURCE_CHAIN.explorer : CONFIG.DEST_CHAIN.explorer;

  return (
    <div>
      {/* Direction toggle */}
      <div className="card">
        <div className="card-title">Direction</div>
        <div className="direction-row">
          <button
            className={`dir-btn ${direction === "LOCK" ? "active" : ""}`}
            onClick={() => setDirection("LOCK")}
          >
            Sepolia → Amoy
          </button>
          <button
            className={`dir-btn ${direction === "BURN" ? "active" : ""}`}
            onClick={() => setDirection("BURN")}
          >
            Amoy → Sepolia
          </button>
        </div>
      </div>

      {/* Balances */}
      {account && (
        <div className="card">
          <div className="card-title">Your balances</div>
          <div className="balance-grid">
            <div className="balance-box">
              <div className="balance-label">BRT — Sepolia</div>
              <div className="balance-amount">{balances.brt}</div>
            </div>
            <div className="balance-box">
              <div className="balance-label">wBRT — Amoy</div>
              <div className="balance-amount">{balances.wbrt}</div>
            </div>
          </div>
        </div>
      )}

      {/* Amount input */}
      {account && (
        <div className="card">
          <div className="card-title">
            {direction === "LOCK" ? "Lock BRT on Sepolia" : "Burn wBRT on Amoy"}
          </div>
          <div className="input-group">
            <input
              type="number"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={loading}
            />
            <span className="input-suffix">{direction === "LOCK" ? "BRT" : "wBRT"}</span>
          </div>
          <button className="bridge-btn" onClick={bridge} disabled={loading || !amount}>
            {loading
              ? "Processing..."
              : direction === "LOCK"
                ? `Bridge ${amount || "0"} BRT → wBRT`
                : `Return ${amount || "0"} wBRT → BRT`}
          </button>
        </div>
      )}

      {/* Transaction lifecycle */}
      {steps.length > 0 && (
        <div className="card">
          <div className="card-title">Transfer status</div>
          {txHash && (
            <div className="tx-ref">
              <span className="tx-label">Source tx:</span>
              <a
                href={`${explorerBase}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="tx-link"
              >
                {shortTx(txHash)}
              </a>
            </div>
          )}
          {messageId && (
            <div className="tx-ref">
              <span className="tx-label">Message ID:</span>
              <span className="tx-mono">{short(messageId)}</span>
              {msgStatus && (
                <span className="status-pill" style={{ background: STATUS_COLOR[msgStatus] || "#888" }}>
                  {msgStatus}
                </span>
              )}
            </div>
          )}
          <div className="steps-list">
            {STEPS.map((step, idx) => {
              const done    = idx < currentStep;
              const current = idx === currentStep;
              return (
                <div key={step.key} className={`step-item ${done ? "done" : current ? "current" : "pending"}`}>
                  <div className="step-dot">{done ? "✓" : current ? "●" : "○"}</div>
                  <div className="step-label">{step.label}</div>
                  {current && msgStatus === "CONFIRMING" && (
                    <div className="step-sub">
                      Waiting for {CONFIG.CONFIRMATIONS_REQUIRED} confirmations...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!account && <div className="card empty-state">Connect your wallet to start bridging</div>}
    </div>
  );
}

// ── Tab: Explorer ────────────────────────────────────────────────────────────
function ExplorerTab() {
  const [query,    setQuery]    = useState("");
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const loadRecent = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/messages?limit=20`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setMessages(data.messages);
      setSelected(null);
    } catch {
      setError("API not reachable. Make sure the relayer is running (node relayer.js).");
    } finally {
      setLoading(false);
    }
  };

  const search = async () => {
    if (!query.trim()) {
      loadRecent();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (query.startsWith("0x") && query.length === 66) {
        // Could be a messageId or a source tx hash — try both.
        let res = await fetch(`${CONFIG.API_URL}/api/messages/${query}`);
        if (res.ok) { setSelected(await res.json()); setMessages([]); return; }

        res = await fetch(`${CONFIG.API_URL}/api/messages/tx/${query}`);
        if (res.ok) { setSelected(await res.json()); setMessages([]); return; }
      } else if (query.startsWith("0x") && query.length === 42) {
        const res = await fetch(`${CONFIG.API_URL}/api/messages/address/${query}`);
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages);
          setSelected(null);
          return;
        }
      }
      setError("No results found. Try a message ID, tx hash, or wallet address.");
    } catch {
      setError("API not reachable. Make sure the relayer is running.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRecent(); }, []);

  return (
    <div>
      <div className="card">
        <div className="card-title">Bridge Explorer</div>
        <div className="search-row">
          <input
            className="search-input"
            placeholder="Search by message ID, tx hash, or wallet address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button className="search-btn" onClick={search}>Search</button>
        </div>
      </div>

      {loading && <div className="card loading">Loading...</div>}
      {error && <div className="card error-card">{error}</div>}

      {selected && (
        <div className="card">
          <div className="card-title">Message detail</div>
          <button className="back-btn" onClick={() => setSelected(null)}>← Back</button>
          <div className="detail-grid">
            <div className="detail-row">
              <span>Status</span>
              <span className="status-pill" style={{ background: STATUS_COLOR[selected.status] || "#888" }}>
                {selected.status}
              </span>
            </div>
            <div className="detail-row"><span>Direction</span><span>{selected.direction}</span></div>
            <div className="detail-row"><span>Message ID</span><span className="mono">{short(selected.message_id)}</span></div>
            <div className="detail-row">
              <span>Source Tx</span>
              <a
                href={`${CONFIG.SOURCE_CHAIN.explorer}/tx/${selected.source_tx_hash}`}
                target="_blank"
                rel="noreferrer"
                className="tx-link"
              >
                {shortTx(selected.source_tx_hash)}
              </a>
            </div>
            {selected.destination_tx_hash && (
              <div className="detail-row">
                <span>Dest Tx</span>
                <a
                  href={`${CONFIG.DEST_CHAIN.explorer}/tx/${selected.destination_tx_hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tx-link"
                >
                  {shortTx(selected.destination_tx_hash)}
                </a>
              </div>
            )}
            <div className="detail-row"><span>Sender</span><span className="mono">{short(selected.sender)}</span></div>
            <div className="detail-row"><span>Recipient</span><span className="mono">{short(selected.recipient)}</span></div>
            <div className="detail-row"><span>Amount (norm)</span><span>{fmt(BigInt(selected.amount))} tokens</span></div>
            <div className="detail-row"><span>Source Block</span><span>{selected.source_block_number}</span></div>
            <div className="detail-row"><span>Retries</span><span>{selected.retry_count}</span></div>
            {selected.last_error && (
              <div className="detail-row error-row"><span>Last Error</span><span>{selected.last_error}</span></div>
            )}
            <div className="detail-row"><span>Created</span><span>{new Date(selected.created_at).toLocaleString()}</span></div>
            <div className="detail-row"><span>Updated</span><span>{new Date(selected.updated_at).toLocaleString()}</span></div>
          </div>
        </div>
      )}

      {messages.length > 0 && !selected && (
        <div className="card">
          <div className="card-title">Recent messages</div>
          <div className="msg-list">
            {messages.map((msg) => (
              <div key={msg.message_id} className="msg-row" onClick={() => setSelected(msg)}>
                <div className="msg-id">{short(msg.message_id)}</div>
                <div className="msg-dir">{msg.direction}</div>
                <div className="msg-amount">{fmt(BigInt(msg.amount))} tokens</div>
                <div>
                  <span className="status-pill" style={{ background: STATUS_COLOR[msg.status] || "#888" }}>
                    {msg.status}
                  </span>
                </div>
                <div className="msg-time">{new Date(msg.created_at).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Metrics ─────────────────────────────────────────────────────────────
function MetricsTab() {
  const [metrics, setMetrics] = useState(null);
  const [error,   setError]   = useState(null);

  const fetchMetrics = async () => {
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/metrics`);
      if (!res.ok) throw new Error("API error");
      setMetrics(await res.json());
      setError(null);
    } catch {
      setError("API not reachable. Make sure the relayer is running.");
    }
  };

  useEffect(() => {
    fetchMetrics();
    const t = setInterval(fetchMetrics, 10000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="card error-card">{error}</div>;
  if (!metrics) return <div className="card loading">Loading metrics...</div>;

  const avg = metrics.timing?.avg_seconds ? `${Math.round(metrics.timing.avg_seconds)}s` : "N/A";

  return (
    <div>
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-value">{metrics.totalMessages}</div>
          <div className="metric-label">Total Messages</div>
        </div>
        <div className="metric-card">
          <div className="metric-value pending-val">{metrics.pending}</div>
          <div className="metric-label">Pending</div>
        </div>
        <div className="metric-card">
          <div className="metric-value success-val">{metrics.completed}</div>
          <div className="metric-label">Completed</div>
        </div>
        <div className="metric-card">
          <div className="metric-value error-val">{metrics.failed}</div>
          <div className="metric-label">Failed</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{avg}</div>
          <div className="metric-label">Avg Process Time</div>
        </div>
        <div className="metric-card">
          <div className="metric-value retry-val">{metrics.retrying}</div>
          <div className="metric-label">Retrying</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Status breakdown</div>
        {Object.entries(metrics.byStatus).map(([status, count]) => (
          <div key={status} className="stat-bar-row">
            <span className="stat-label">{status}</span>
            <div className="stat-bar-track">
              <div
                className="stat-bar-fill"
                style={{
                  width: metrics.totalMessages > 0 ? `${(count / metrics.totalMessages) * 100}%` : "0%",
                  background: STATUS_COLOR[status] || "#888",
                }}
              />
            </div>
            <span className="stat-count">{count}</span>
          </div>
        ))}
      </div>

      {metrics.volume.length > 0 && (
        <div className="card">
          <div className="card-title">Volume by token</div>
          {metrics.volume.map((row) => (
            <div key={row.token} className="stat-bar-row">
              <span className="stat-label mono">{short(row.token)}</span>
              <span className="stat-count">{row.message_count} tx</span>
            </div>
          ))}
        </div>
      )}

      <div className="card refresh-note">Auto-refreshing every 10 seconds</div>
    </div>
  );
}

// ── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,      setTab]      = useState("bridge");
  const [account,  setAccount]  = useState(null);
  const [provider, setProvider] = useState(null);
  const [chainId,  setChainId]  = useState(null);

  const connect = async () => {
    if (!window.ethereum) { alert("MetaMask not found."); return; }
    const p = new ethers.BrowserProvider(window.ethereum);
    const [acct] = await p.send("eth_requestAccounts", []);
    const net = await p.getNetwork();
    setProvider(p);
    setAccount(acct);
    setChainId(net.chainId.toString(16));
    window.ethereum.on("accountsChanged", ([a]) => setAccount(a));
    window.ethereum.on("chainChanged", () => window.location.reload());
  };

  return (
    <div className="app">
      <div className="header">
        <h1>Cross-Chain Bridge</h1>
        <p>Ethereum Sepolia ↔ Polygon Amoy</p>
        {!account
          ? <button className="connect-btn" onClick={connect}>Connect MetaMask</button>
          : <span className="address-pill">{short(account)}</span>}
      </div>

      <div className="tabs">
        {["bridge", "explorer", "metrics"].map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "bridge" && <BridgeTab account={account} provider={provider} chainId={chainId} />}
      {tab === "explorer" && <ExplorerTab />}
      {tab === "metrics" && <MetricsTab />}
    </div>
  );
}
