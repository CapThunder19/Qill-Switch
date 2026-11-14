/**
 * Send one owner-signed (ML-DSA-87) command to the deployed QillVault via the relayer.
 *   tsx scripts/owner-cmd.ts pause
 *   tsx scripts/owner-cmd.ts setExecutor 0x...
 *   tsx scripts/owner-cmd.ts withdraw <to> <token|0x0> <amountWei>
 *   add --dry to sign + simulate only
 *   add --vault 0x... to target a vault other than deployments/<chain>.json
 *   add --relayer <name> to relay from another account (default funder)
 */
import { isAddress, type Address } from "viem";
import { COMMANDS, deployment, publicClient, relayToVault, signOwnerCommand, VAULT_ABI, type CommandName } from "../src/vault.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const vaultFlag = flag("--vault");
const relayer = flag("--relayer") ?? "funder";
const dry = argv.includes("--dry");
const [cmd, ...rest] = argv.filter((a) => a !== "--dry");
if (!cmd || !(cmd in COMMANDS)) throw new Error(`usage: owner-cmd <${Object.keys(COMMANDS).join("|")}> [args] [--vault 0x..] [--dry]`);
if (vaultFlag && !isAddress(vaultFlag)) throw new Error(`bad --vault ${vaultFlag}`);
const c = COMMANDS[cmd as CommandName];
const args = rest.map((a, i) => (c.types[i]?.type === "uint256" ? BigInt(a) : a));
const vault = (vaultFlag ?? deployment().contracts.QillVault) as Address;

const read = async (fn: string) => publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: fn });
const state = async () => ({ ownerNonce: await read("ownerNonce"), paused: await read("paused"), qDayFrozen: await read("qDayFrozen"), executor: await read("executor") });

console.log("vault", vault, "before", await state());
const { data, auth } = await signOwnerCommand(vault, cmd as CommandName, args);
console.log(`signed ${cmd} nonce=${auth.nonce} expiry=${auth.expiry} sig=${(auth.signature.length - 2) / 2} bytes pk=${(auth.pubkey.length - 2) / 2} bytes`);
if (dry) {
  await publicClient.call({ to: vault, data });
  console.log("simulation ok (dry run)");
} else {
  const r = await relayToVault(vault, data, relayer);
  console.log("relayed", r);
  console.log("after", await state());
}
