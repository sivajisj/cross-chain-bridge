export const CONFIG = {
  SOURCE_CHAIN: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    rpcUrl: "https://eth-sepolia.g.alchemy.com/v2/WH4VCblvDcg5UVZD1e1hm3iSLuzKLey0",  // ← Sepolia URL
    explorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },

  DEST_CHAIN: {
    chainId: "0x13882",
    chainName: "Polygon Amoy",
    rpcUrl: "https://polygon-amoy.g.alchemy.com/v2/L9HYmJZaIAh8z8LbLbb--wgt512Akf-Q",  // ← Amoy URL
    explorer: "https://amoy.polygonscan.com",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  },

  ADDRESSES: {
    mockToken:    "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b",
    bridgeSource: "0xF30f2aB2EC89C5Cff7A31554C8117CD7345dbDc8",
    bridgeDest:   "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b",
  },
};