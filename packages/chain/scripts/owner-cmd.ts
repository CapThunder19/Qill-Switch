/**
 * Send one owner-signed (ML-DSA-87) command to the deployed QillVault via the relayer.
 *   tsx scripts/owner-cmd.ts pause
 *   tsx scripts/owner-cmd.ts setExecutor 0x...
 *   tsx scripts/owner-cmd.ts withdraw <to> <token|0x0> <amountWei>
 *   add --dry to sign + simulate only
 */
import { COMMANDS, deployment, publicClient, relayToVault, signOwnerCommand, VAULT_ABI, type CommandName } from "../src/vault.js";

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--dry");
const dry = process.argv.includes("--dry");
if (!cmd || !(cmd in COMMANDS)) throw new Error(`usage: owner-cmd <${Object.keys(COMMANDS).join("|")}> [args]`);
const c = COMMANDS[cmd as CommandName];
const args = rest.map((a, i) => (c.types[i]?.type === "uint256" ? BigInt(a) : a));
const vault = deployment().contracts.QillVault;

const read = async (fn: string) => publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: fn });
const state = async () => ({ ownerNonce: await read("ownerNonce"), paused: await read("paused"), qDayFrozen: await read("qDayFrozen"), executor: await read("executor") });

console.log("vault", vault, "before", await state());
const { data, auth } = await signOwnerCommand(vault, cmd as CommandName, args);
console.log(`signed ${cmd} nonce=${auth.nonce} expiry=${auth.expiry} sig=${(auth.signature.length - 2) / 2} bytes pk=${(auth.pubkey.length - 2) / 2} bytes`);
if (dry) {
  await publicClient.call({ to: vault, data });
  console.log("simulation ok (dry run)");
} else {
  const r = await relayToVault(vault, data);
  console.log("relayed", r);
  console.log("after", await state());
}
