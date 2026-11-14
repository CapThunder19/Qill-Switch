// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice QoreChain PQC Verify precompile (testnet `qorechain-diana`), address 0x...0A01.
/// @dev Always call through this typed interface: on a chain where the precompile is inactive the call
///      returns empty data, and the ABI decoder then reverts instead of yielding a bool.
interface IQorePQC {
    /// @param pubkey    2,592-byte ML-DSA-87 public key
    /// @param signature 4,627-byte ML-DSA-87 signature (FIPS 204, empty context)
    /// @param message   raw message bytes (the precompile does not hash them)
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);
}

/// @notice QoreChain PQC Key Status precompile, address 0x...0A02 (2,500 gas).
interface IQorePQCKeyStatus {
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
