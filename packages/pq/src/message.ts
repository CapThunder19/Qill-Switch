import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

/** Domain tag. Must match QillMessage.DOMAIN in Solidity. */
export const DOMAIN = "QILLSWITCH_V1" as const;

/** Action identifiers = keccak256(name). Must match QillMessage.sol. */
export const ACTION_NAMES = [
  "CREATE_MANDATE",
  "REVOKE_MANDATE",
  "PAUSE",
  "RESUME",
  "SET_EXECUTOR",
  "SET_GUARDIAN_KEY",
  "WITHDRAW",
  "ROTATE_OWNER_KEY",
  "Q_DAY",
  "SET_ALLOWLIST",
  "GUARDIAN_APPROVE_TRADE",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export function actionId(name: ActionName): Hex {
  return keccak256(toHex(name));
}

export interface CanonicalMessage {
  chainId: bigint;
  verifyingContract: Address;
  action: ActionName;
  /** abi-encoded params (the raw bytes, not the hash). */
  params: Hex;
  nonce: bigint;
  expiry: bigint;
}

/**
 * message = abi.encode("QILLSWITCH_V1", chainid, address(this), action, keccak256(params), nonce, uint64 expiry)
 * Byte-identical to QillMessage.encode in Solidity.
 */
export function encodeMessage(m: CanonicalMessage): Hex {
  if (m.expiry < 0n || m.expiry >= 1n << 64n) throw new Error("expiry out of uint64 range");
  return encodeAbiParameters(
    [
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint64" },
    ],
    [DOMAIN, m.chainId, m.verifyingContract, actionId(m.action), keccak256(m.params), m.nonce, m.expiry],
  );
}
