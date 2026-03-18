require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { 
  SEPOLIA_RPC_URL, 
  AMOY_RPC_URL, 
  PRIVATE_KEY, 
  ETHERSCAN_API_KEY,
  RELAYER_PRIVATE_KEY
} = process.env;

module.exports = {
  solidity: "0.8.20",

  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    amoy: {
      url: AMOY_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    "amoy-relayer": {
      url: AMOY_RPC_URL || "",
      accounts: RELAYER_PRIVATE_KEY ? [RELAYER_PRIVATE_KEY] : [],
    },
  },

  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "polygonAmoy",
        chainId: 80002,
        urls: {
          apiURL: "https://api-amoy.polygonscan.com/api",
          browserURL: "https://amoy.polygonscan.com",
        },
      },
    ],
  },

  sourcify: {
    enabled: false,
  },
};