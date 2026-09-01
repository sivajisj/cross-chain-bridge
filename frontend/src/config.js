export const CONFIG = {
  SOURCE_CHAIN: {
    chainId:  "0xaa36a7",
    chainName: "Ethereum Sepolia",
    rpcUrl:   "https://eth-sepolia.g.alchemy.com/v2/WH4VCblvDcg5UVZD1e1hm3iSLuzKLey0",
    explorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },

  DEST_CHAIN: {
    chainId:  "0x13882",
    chainName: "Polygon Amoy",
    rpcUrl:   "https://polygon-amoy.g.alchemy.com/v2/L9HYmJZaIAh8z8LbLbb--wgt512Akf-Q",
    explorer: "https://amoy.polygonscan.com",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  },

  // TODO: these still point at the old Phase 1/2 deployment (single-token
  // BridgeSource, ERC20-itself BridgeDest). The Phase 3 contracts have a
  // different ABI (lockTokens/mint/burn all take a token address, and the
  // wrapped balance lives on a separate WrappedToken contract) and have not
  // been redeployed to Sepolia/Amoy yet. Run scripts/deploy-source.js and
  // scripts/deploy-dest.js, then replace these three addresses before
  // bridging against a live network — this frontend will otherwise call
  // functions that don't exist on the currently-deployed bytecode.
  ADDRESSES: {
    mockToken:    "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b",
    bridgeSource: "0xF30f2aB2EC89C5Cff7A31554C8117CD7345dbDc8",
    bridgeDest:   "0x80E0E536d5827895E170E2D4F0d19bc1756A51E4",
  },

  // Bridge explorer + metrics API (relayer's Express server)
  API_URL: "http://localhost:3001",

  // Confirmation target shown in UI progress bar
  CONFIRMATIONS_REQUIRED: 5,
};
