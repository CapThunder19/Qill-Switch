// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {QillVault} from "../src/QillVault.sol";
import {QillMessage} from "../src/libraries/QillMessage.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Attacker handler: random callers hit every external vault function with junk,
///         replayed, or mis-bound signatures. Only an ECDSA-style attacker is modelled: it has
///         no owner/guardian ML-DSA key and is never the executor.
contract AttackerHandler is Test {
    QillVault public vault;
    MockERC20 public tokA;
    MockERC20 public tokB;
    address public pool;
    address public executor;
    bytes public ownerPk;
    QillVault.OwnerAuth public usedAuth; // a real owner signature that has already been consumed
    uint256 public calls;

    constructor(QillVault v, MockERC20 a, MockERC20 b, address p, address exec, bytes memory pk, QillVault.OwnerAuth memory used) {
        vault = v;
        tokA = a;
        tokB = b;
        pool = p;
        executor = exec;
        ownerPk = pk;
        usedAuth = used;
    }

    modifier asAttacker(address caller) {
        if (caller == executor) caller = address(0xBAD);
        vm.startPrank(caller);
        _;
        vm.stopPrank();
        calls++;
    }

    function _junk(bytes memory sig, uint256 nonce, uint64 expiry, bool realPk) internal view returns (QillVault.OwnerAuth memory) {
        return QillVault.OwnerAuth(realPk ? ownerPk : sig, sig, nonce, expiry);
    }

    function _replay() internal view returns (QillVault.OwnerAuth memory a) {
        (bytes memory pk, bytes memory sig, uint256 n, uint64 e) = vault_usedAuth();
        a = QillVault.OwnerAuth(pk, sig, n, e);
    }

    function vault_usedAuth() internal view returns (bytes memory, bytes memory, uint256, uint64) {
        return (usedAuth.pubkey, usedAuth.signature, usedAuth.nonce, usedAuth.expiry);
    }

    function withdraw(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk, bool replay, uint256 amount, bool native)
        external
        asAttacker(caller)
    {
        QillVault.OwnerAuth memory a = replay ? _replay() : _junk(sig, nonce, expiry, realPk);
        try vault.withdraw(a, caller, native ? address(0) : address(tokA), amount) {} catch {}
    }

    function trade(address caller, uint256 amountIn, uint256 minOut, bool flip) external asAttacker(caller) {
        QillVault.TradeParams memory t = QillVault.TradeParams({
            mandateId: keccak256("mandate-1"),
            pool: pool,
            tokenIn: flip ? address(tokB) : address(tokA),
            tokenOut: flip ? address(tokA) : address(tokB),
            amountIn: amountIn,
            minOut: minOut
        });
        QillVault.OwnerAuth memory none;
        try vault.trade(t, none) {} catch {}
    }

    function setExecutor(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk) external asAttacker(caller) {
        try vault.setExecutor(_junk(sig, nonce, expiry, realPk), caller) {} catch {}
    }

    function rotateOwnerKey(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk) external asAttacker(caller) {
        try vault.rotateOwnerKey(_junk(sig, nonce, expiry, realPk), keccak256(abi.encode(caller))) {} catch {}
    }

    function setGuardianKey(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk) external asAttacker(caller) {
        try vault.setGuardianKey(_junk(sig, nonce, expiry, realPk), keccak256(abi.encode(caller))) {} catch {}
    }

    function setAllowlist(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk) external asAttacker(caller) {
        try vault.setAllowlist(_junk(sig, nonce, expiry, realPk), QillVault.ListKind.Pool, caller, true) {} catch {}
    }

    function resumeOrPauseOrQDay(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk, bool replay, uint8 which)
        external
        asAttacker(caller)
    {
        QillVault.OwnerAuth memory a = replay ? _replay() : _junk(sig, nonce, expiry, realPk);
        which %= 3;
        if (which == 0) try vault.pause(a) {} catch {}
        else if (which == 1) try vault.resume(a) {} catch {}
        else try vault.qDay(a) {} catch {}
    }

    function createMandate(address caller, bytes memory sig, uint256 nonce, uint64 expiry, bool realPk) external asAttacker(caller) {
        QillVault.MandateParams memory p;
        p.id = keccak256(abi.encode(caller));
        try vault.createMandate(_junk(sig, nonce, expiry, realPk), p) {} catch {}
    }

    function sendTokens(address caller, uint256 amount) external asAttacker(caller) {
        // attacker can try approvals/transfers on tokens it holds; the vault's own balance can't be touched
        try tokA.transferFrom(address(vault), caller, amount) {} catch {}
        try tokA.approve(address(vault), amount) {} catch {}
    }
}

contract QillVaultInvariantTest is Base {
    AttackerHandler handler;
    uint256 a0;
    uint256 b0;
    uint256 n0;
    bytes32 ownerHash0;
    bytes32 guardianHash0;

    function setUp() public override {
        super.setUp();
        // consume one real owner signature so the handler can replay it
        QillVault.OwnerAuth memory used = _owner(QillMessage.PAUSE, "");
        vault.pause(used);
        vault.resume(_owner(QillMessage.RESUME, ""));

        handler = new AttackerHandler(vault, tokA, tokB, address(pool), executor, ownerPk, used);
        (a0, b0, n0) = _vaultValue();
        ownerHash0 = vault.ownerKeyHash();
        guardianHash0 = vault.guardianKeyHash();
        targetContract(address(handler));
    }

    function invariant_vaultValueNeverDecreases() public view {
        (uint256 a, uint256 b, uint256 n) = _vaultValue();
        assertGe(a, a0);
        assertGe(b, b0);
        assertGe(n, n0);
    }

    function invariant_controlNeverChanges() public view {
        assertEq(vault.ownerKeyHash(), ownerHash0);
        assertEq(vault.guardianKeyHash(), guardianHash0);
        assertEq(vault.executor(), executor);
        assertEq(vault.ownerNonce(), 3);
        assertFalse(vault.paused());
        assertFalse(vault.qDayFrozen());
        assertEq(vault.mandateCount(), 1);
    }
}
