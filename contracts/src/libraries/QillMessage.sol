// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title QillMessage: canonical owner/guardian signed message
/// @notice message = abi.encode("QILLSWITCH_V1", chainid, verifyingContract, action, keccak256(params), nonce, uint64 expiry)
/// @dev Byte-identical to `encodeMessage` in packages/pq/src/message.ts (see test/vectors/message.json).
library QillMessage {
    string internal constant DOMAIN = "QILLSWITCH_V1";

    bytes32 internal constant CREATE_MANDATE = keccak256("CREATE_MANDATE");
    bytes32 internal constant REVOKE_MANDATE = keccak256("REVOKE_MANDATE");
    bytes32 internal constant PAUSE = keccak256("PAUSE");
    bytes32 internal constant RESUME = keccak256("RESUME");
    bytes32 internal constant SET_EXECUTOR = keccak256("SET_EXECUTOR");
    bytes32 internal constant SET_GUARDIAN_KEY = keccak256("SET_GUARDIAN_KEY");
    bytes32 internal constant WITHDRAW = keccak256("WITHDRAW");
    bytes32 internal constant ROTATE_OWNER_KEY = keccak256("ROTATE_OWNER_KEY");
    bytes32 internal constant Q_DAY = keccak256("Q_DAY");
    bytes32 internal constant SET_ALLOWLIST = keccak256("SET_ALLOWLIST");
    bytes32 internal constant GUARDIAN_APPROVE_TRADE = keccak256("GUARDIAN_APPROVE_TRADE");

    function encodeFor(
        uint256 chainId,
        address verifyingContract,
        bytes32 action,
        bytes memory params,
        uint256 nonce,
        uint64 expiry
    ) internal pure returns (bytes memory) {
        return abi.encode(DOMAIN, chainId, verifyingContract, action, keccak256(params), nonce, expiry);
    }

    function encode(bytes32 action, bytes memory params, uint256 nonce, uint64 expiry)
        internal
        view
        returns (bytes memory)
    {
        return encodeFor(block.chainid, address(this), action, params, nonce, expiry);
    }
}
