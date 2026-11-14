import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  paths: {
    sources: "src",
    tests: { solidity: "test" },
  },
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "paris",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  test: {
    solidity: {
      fsPermissions: { readFile: ["test/vectors/message.json"] },
      fuzz: { runs: 1000 },
      invariant: { runs: 256, depth: 64, failOnRevert: false },
    },
  },
  networks: {
    // QoreChain testnet (qorechain-diana). EVM txs only land inside an open, scoped PQC window.
    qoreTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 9800,
      url: configVariable("QORE_EVM_RPC"),
      // stored with `pnpm hardhat keystore set QORE_DEPLOYER_KEY` (encrypted, never in the repo)
      accounts: [configVariable("QORE_DEPLOYER_KEY")],
    },
  },
});
