require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const TOKEN_ADDRESS  = "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b";
  const WALLET_TO_FUND = "0x21abDd5D4e1cFe21E3885AC932eAF021ED744A62";
  const amount = hre.ethers.parseEther("500");

  const token = await hre.ethers.getContractAt("MockERC20", TOKEN_ADDRESS);
  const tx = await token.mint(WALLET_TO_FUND, amount);
  await tx.wait();
  console.log("Minted 500 BRT to:", WALLET_TO_FUND);
}

main().catch(console.error);
