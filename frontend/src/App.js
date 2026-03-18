import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { CONFIG } from "./config";
import BridgeSourceABI from "./abis/BridgeSource.json";
import BridgeDestABI   from "./abis/BridgeDest.json";
import MockERC20ABI    from "./abis/MockERC20.json";
import "./App.css";

// ── helpers ────────────────────────────────────────────────────
const fmt = (val) => parseFloat(ethers.formatEther(val)).toFixed(4);
const short = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

export default function App() {
  const [account,     setAccount]     = useState(null);
  const [provider,    setProvider]    = useState(null);
  const [chainId,     setChainId]     = useState(null);
  const [amount,      setAmount]      = useState("");
  const [statuses,    setStatuses]    = useState([]);
  const [balances,    setBalances]    = useState({ brt: "0", wbrt: "0" });
  const [loading,     setLoading]     = useState(false);

  const addStatus = (label, type = "pending", sub = "") =>
    setStatuses(prev => [{ label, type, sub, id: Date.now() }, ...prev]);

  const updateLast = (type, sub = "") =>
    setStatuses(prev => prev.map((s, i) => i === 0 ? { ...s, type, sub } : s));

  // ── fetch balances on both chains ──────────────────────────
const fetchBalances = useCallback(async (userAccount) => {
  if (!userAccount) return;
  try {
    console.log("Fetching BRT from Sepolia...");
    console.log("RPC:", CONFIG.SOURCE_CHAIN.rpcUrl);
    console.log("Token:", CONFIG.ADDRESSES.mockToken);

    const sepoliaProvider = new ethers.JsonRpcProvider(CONFIG.SOURCE_CHAIN.rpcUrl);

    // Check contract exists first
    const code = await sepoliaProvider.getCode(CONFIG.ADDRESSES.mockToken);
    console.log("Token contract code length:", code.length);

    const tokenContract = new ethers.Contract(
      CONFIG.ADDRESSES.mockToken,
      MockERC20ABI.abi,
      sepoliaProvider
    );
    const brt = await tokenContract.balanceOf(userAccount);
    console.log("BRT raw:", brt.toString());

    console.log("Fetching wBRT from Amoy...");
    console.log("RPC:", CONFIG.DEST_CHAIN.rpcUrl);
    console.log("BridgeDest:", CONFIG.ADDRESSES.bridgeDest);

    const amoyProvider = new ethers.JsonRpcProvider(CONFIG.DEST_CHAIN.rpcUrl);

    const code2 = await amoyProvider.getCode(CONFIG.ADDRESSES.bridgeDest);
    console.log("BridgeDest contract code length:", code2.length);

    const destContract = new ethers.Contract(
      CONFIG.ADDRESSES.bridgeDest,
      BridgeDestABI.abi,
      amoyProvider
    );
    const wbrt = await destContract.balanceOf(userAccount);
    console.log("wBRT raw:", wbrt.toString());

    setBalances({ brt: fmt(brt), wbrt: fmt(wbrt) });
  } catch (err) {
    console.error("Balance fetch failed:", err.message);
  }
}, []);

  // ── connect MetaMask ───────────────────────────────────────
  const connectWallet = async () => {
    if (!window.ethereum) {
      alert("MetaMask not found. Please install it.");
      return;
    }
    const p = new ethers.BrowserProvider(window.ethereum);
    const accounts = await p.send("eth_requestAccounts", []);
    const network  = await p.getNetwork();

    setProvider(p);
    setAccount(accounts[0]);
    setChainId(network.chainId.toString(16));
    fetchBalances(accounts[0]);

    // Listen for account/network changes
    window.ethereum.on("accountsChanged", ([a]) => { setAccount(a); fetchBalances(a); });
    window.ethereum.on("chainChanged",    () => window.location.reload());
  };

  // ── switch to Sepolia ──────────────────────────────────────
  const switchToSepolia = async () => {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CONFIG.SOURCE_CHAIN.chainId }],
      });
    } catch (err) {
      // Chain not added yet — add it
      if (err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [CONFIG.SOURCE_CHAIN],
        });
      }
    }
  };

  // ── main bridge function ───────────────────────────────────
  const bridgeTokens = async () => {
    if (!account || !amount || parseFloat(amount) <= 0) return;

    // Must be on Sepolia to lock tokens
    if (chainId !== CONFIG.SOURCE_CHAIN.chainId.replace("0x", "")) {
      addStatus("Wrong network", "error", "Please switch to Sepolia first");
      return;
    }

    setLoading(true);
    setStatuses([]);

    try {
      const signer     = await provider.getSigner();
      const parsedAmt  = ethers.parseEther(amount);

      // Step 1 — Approve
      addStatus("Approving BRT spend...", "pending");
      const tokenContract = new ethers.Contract(
        CONFIG.ADDRESSES.mockToken,
        MockERC20ABI.abi,
        signer
      );
      const approveTx = await tokenContract.approve(
        CONFIG.ADDRESSES.bridgeSource,
        parsedAmt
      );
      await approveTx.wait();
      updateLast("success", `Tx: ${short(approveTx.hash)}`);

      // Step 2 — Lock
      addStatus("Locking tokens on Sepolia...", "pending");
      const bridgeContract = new ethers.Contract(
        CONFIG.ADDRESSES.bridgeSource,
        BridgeSourceABI.abi,
        signer
      );
      const lockTx = await bridgeContract.lockTokens(parsedAmt);
      await lockTx.wait();
      updateLast("success", `Tx: ${short(lockTx.hash)}`);

      // Step 3 — Wait for relayer
      addStatus("Waiting for relayer to mint on Polygon...", "pending",
        "This takes 15–30 seconds");

      // Poll wBRT balance until it increases
      const prevWbrt = parseFloat(balances.wbrt);
      let minted = false;
      for (let i = 0; i < 24; i++) {   // max ~2 min
        await new Promise(r => setTimeout(r, 5000));
        const amoyProvider = new ethers.JsonRpcProvider(CONFIG.DEST_CHAIN.rpcUrl);
        const destContract = new ethers.Contract(
          CONFIG.ADDRESSES.bridgeDest,
          BridgeDestABI.abi,
          amoyProvider
        );
        const newWbrt = parseFloat(fmt(await destContract.balanceOf(account)));
        if (newWbrt > prevWbrt) {
          updateLast("success", `${amount} wBRT arrived on Polygon Amoy`);
          minted = true;
          break;
        }
      }

      if (!minted) {
        updateLast("error", "Relayer may be slow — check Amoy balance manually");
      }

      // Refresh balances
      await fetchBalances(account);
      setAmount("");

    } catch (err) {
      updateLast("error", err.reason || err.message);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ── auto-refresh balances every 30s ───────────────────────
  useEffect(() => {
    if (!account) return;
    const interval = setInterval(() => fetchBalances(account), 30000);
    return () => clearInterval(interval);
  }, [account, fetchBalances]);

  const onSepolia = chainId === CONFIG.SOURCE_CHAIN.chainId.replace("0x", "");

  // ── render ─────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="header">
        <h1>Cross-Chain Bridge</h1>
        <p>Transfer BRT from Ethereum Sepolia to Polygon Amoy</p>
      </div>

      {/* Wallet card */}
      <div className="card">
        <div className="card-title">Wallet</div>
        {!account ? (
          <button className="connect-btn" onClick={connectWallet}>
            Connect MetaMask
          </button>
        ) : (
          <>
            <span className="address-pill">{short(account)}</span>
            {!onSepolia && (
              <button className="switch-btn" onClick={switchToSepolia}>
                Switch to Sepolia to bridge
              </button>
            )}
          </>
        )}
      </div>

      {/* Balances card */}
      {account && (
        <div className="card">
          <div className="card-title">Your balances</div>
          <div className="balance-grid">
            <div className="balance-box">
              <div className="balance-label">To bridge</div>
              <div>
                <span className="balance-amount">{balances.brt}</span>
                <span className="balance-symbol">BRT</span>
              </div>
              <div className="network-tag">Ethereum Sepolia</div>
            </div>
            <div className="balance-box">
              <div className="balance-label">Bridged</div>
              <div>
                <span className="balance-amount">{balances.wbrt}</span>
                <span className="balance-symbol">wBRT</span>
              </div>
              <div className="network-tag">Polygon Amoy</div>
            </div>
          </div>
        </div>
      )}

      {/* Bridge card */}
      {account && (
        <div className="card">
          <div className="card-title">Bridge tokens</div>
          <div className="input-group">
            <label>Amount to bridge</label>
            <input
              type="number"
              placeholder="0.0"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={loading}
            />
          </div>
          <button
            className="bridge-btn"
            onClick={bridgeTokens}
            disabled={loading || !amount || !onSepolia}
          >
            {loading ? "Bridging..." : `Bridge ${amount || "0"} BRT → wBRT`}
          </button>
        </div>
      )}

      {/* Status card */}
      {statuses.length > 0 && (
        <div className="card">
          <div className="card-title">Transaction status</div>
          <div className="status-list">
            {statuses.map(s => (
              <div className="status-item" key={s.id}>
                <div className={`status-dot ${s.type}`} />
                <div>
                  <div className="status-label">{s.label}</div>
                  {s.sub && <div className="status-sub">{s.sub}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}