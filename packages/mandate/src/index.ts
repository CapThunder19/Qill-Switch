import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@qill/chain";
import type { Universe } from "./schema.js";

export * from "./schema.js";
export * from "./parse.js";
export * from "./validate.js";
export * from "./compile.js";
export * from "./llm.js";

/** Build the token/pool universe from a deployment record (deployments/<name>.json). */
export function universeFromDeployment(name: string): Universe {
  const d = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${name}.json`), "utf8"));
  return {
    vault: d.contracts.QillVault,
    tokens: { QTA: { address: d.contracts.TokenA, decimals: 18 }, QTB: { address: d.contracts.TokenB, decimals: 18 } },
    pools: { "demo-pool": { address: d.contracts.MockPool, tokens: ["QTA", "QTB"] } },
  };
}
