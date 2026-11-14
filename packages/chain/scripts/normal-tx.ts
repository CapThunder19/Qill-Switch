/**
 * The drill's "normal transaction": a HYBRID-signed (secp256k1 + ML-DSA-87) Cosmos-lane transfer from the
 * drill account. It needs no EVM window, so nothing is ever opened on the drill account.
 *   tsx scripts/normal-tx.ts [amountUqor]   (default 10000 = 0.01 QOR, sent to our funder account)
 */
import { accountAddresses, loadAccount } from "../src/accounts.js";
import { bankSend, evmWindow, getBalance } from "../src/cosmos.js";

const amount = BigInt(process.argv[2] ?? "10000");
const drill = loadAccount("drill");
const to = accountAddresses("funder").cosmos;
const before = await getBalance(drill.cosmos);
const r = await bankSend(drill, to, amount);
const after = await getBalance(drill.cosmos);
const w = await evmWindow(drill.cosmos);
console.log(`hybrid transfer ${amount} uqor drill → funder: tx ${r.transactionHash} height ${r.height}`);
console.log(`drill balance ${Number(before) / 1e6} → ${Number(after) / 1e6} QOR; EVM window live=${w.live}`);
