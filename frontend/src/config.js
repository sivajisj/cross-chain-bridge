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
  mockToken:    "0xe525bD36eb1BA6438345862938F04C7269B8515c",
  bridgeSource: "0xabf0C2500c70BF43CCad444b510F2e7579576905",
  bridgeDest:   "0x99b3480DDde7904f849CbAAD866B04F5df0A3a05",
},

  // Bridge explorer + metrics API (relayer's Express server)
  API_URL: "http://localhost:3001",

  // Confirmation target shown in UI progress bar
  CONFIRMATIONS_REQUIRED: 5,
};
