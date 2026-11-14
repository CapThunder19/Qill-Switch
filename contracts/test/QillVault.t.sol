// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "./Base.t.sol";
import {QillVault} from "../src/QillVault.sol";
import {QillMessage} from "../src/libraries/QillMessage.sol";
import {MockPool} from "../src/mocks/MockPool.sol";
import {StealingPool, LyingPool, GreedyPool, ReentrantPool} from "./mocks/TestMocks.sol";

contract QillVaultOwnerActionsTest is Base {
    uint8 constant N_ACTIONS = 10;

    /// (action id, abi-encoded params) for owner action `i`.
    function _spec(uint8 i) internal view returns (bytes32 action, bytes memory params) {
        if (i == 0) return (QillMessage.CREATE_MANDATE, abi.encode(_defaultMandate(keccak256("m2"))));
        if (i == 1) return (QillMessage.REVOKE_MANDATE, abi.encode(MID));
        if (i == 2) return (QillMessage.PAUSE, "");
        if (i == 3) return (QillMessage.RESUME, "");
        if (i == 4) return (QillMessage.SET_EXECUTOR, abi.encode(attacker));
        if (i == 5) return (QillMessage.SET_GUARDIAN_KEY, abi.encode(keccak256("evil")));
        if (i == 6) return (QillMessage.SET_ALLOWLIST, abi.encode(QillVault.ListKind.Pool, attacker, true));
        if (i == 7) return (QillMessage.WITHDRAW, abi.encode(attacker, address(tokA), 1 * ONE));
        if (i == 8) return (QillMessage.ROTATE_OWNER_KEY, abi.encode(keccak256("evil")));
        return (QillMessage.Q_DAY, "");
    }

    function _invoke(uint8 i, QillVault.OwnerAuth memory a) internal {
        if (i == 0) vault.createMandate(a, _defaultMandate(keccak256("m2")));
        else if (i == 1) vault.revokeMandate(a, MID);
        else if (i == 2) vault.pause(a);
        else if (i == 3) vault.resume(a);
        else if (i == 4) vault.setExecutor(a, attacker);
        else if (i == 5) vault.setGuardianKey(a, keccak256("evil"));
        else if (i == 6) vault.setAllowlist(a, QillVault.ListKind.Pool, attacker, true);
        else if (i == 7) vault.withdraw(a, attacker, address(tokA), 1 * ONE);
        else if (i == 8) vault.rotateOwnerKey(a, keccak256("evil"));
        else vault.qDay(a);
    }

    function _good(uint8 i) internal view returns (QillVault.OwnerAuth memory) {
        (bytes32 action, bytes memory params) = _spec(i);
        return _owner(action, params);
    }

    function test_everyAction_succeedsWithValidSignature() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 n = vault.ownerNonce();
            _invoke(i, _good(i));
            assertEq(vault.ownerNonce(), n + 1, "nonce bump");
            vm.revertToState(snap);
        }
    }

    function test_everyAction_rejectsWrongPubkey() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            (bytes32 action, bytes memory params) = _spec(i);
            bytes memory evilPk = _fakePubkey(0x99);
            QillVault.OwnerAuth memory a = _signFor(evilPk, block.chainid, address(vault), action, params, vault.ownerNonce(), uint64(block.timestamp + 1));
            vm.expectRevert(QillVault.WrongKey.selector);
            _invoke(i, a);
        }
    }

    function test_everyAction_rejectsBadSignature() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            QillVault.OwnerAuth memory a = _good(i);
            a.signature[0] = bytes1(uint8(a.signature[0]) ^ 1);
            vm.expectRevert(QillVault.BadSignature.selector);
            _invoke(i, a);
            a.signature = "";
            vm.expectRevert(QillVault.BadSignature.selector);
            _invoke(i, a);
        }
    }

    function test_everyAction_rejectsReplayedAndFutureNonce() public {
        // consume nonce 0 with a pause, then every action signed at nonce 0 is a replay
        QillVault.OwnerAuth memory p0 = _owner(QillMessage.PAUSE, "");
        vault.pause(p0);
        vm.expectRevert(QillVault.BadNonce.selector);
        vault.pause(p0);
        for (uint8 i; i < N_ACTIONS; ++i) {
            (bytes32 action, bytes memory params) = _spec(i);
            QillVault.OwnerAuth memory replay = _signFor(ownerPk, block.chainid, address(vault), action, params, 0, uint64(block.timestamp + 1));
            vm.expectRevert(QillVault.BadNonce.selector);
            _invoke(i, replay);
            QillVault.OwnerAuth memory future = _signFor(ownerPk, block.chainid, address(vault), action, params, vault.ownerNonce() + 1, uint64(block.timestamp + 1));
            vm.expectRevert(QillVault.BadNonce.selector);
            _invoke(i, future);
        }
    }

    function test_everyAction_rejectsExpired() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            (bytes32 action, bytes memory params) = _spec(i);
            QillVault.OwnerAuth memory a = _signFor(ownerPk, block.chainid, address(vault), action, params, vault.ownerNonce(), uint64(block.timestamp - 1));
            vm.expectRevert(QillVault.SignatureExpired.selector);
            _invoke(i, a);
        }
    }

    function test_everyAction_rejectsWrongChainId() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            (bytes32 action, bytes memory params) = _spec(i);
            QillVault.OwnerAuth memory a = _signFor(ownerPk, 1, address(vault), action, params, vault.ownerNonce(), uint64(block.timestamp + 1));
            vm.expectRevert(QillVault.BadSignature.selector);
            _invoke(i, a);
        }
    }

    function test_everyAction_rejectsWrongContract() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            (bytes32 action, bytes memory params) = _spec(i);
            QillVault.OwnerAuth memory a = _signFor(ownerPk, block.chainid, address(0xBEEF), action, params, vault.ownerNonce(), uint64(block.timestamp + 1));
            vm.expectRevert(QillVault.BadSignature.selector);
            _invoke(i, a);
        }
    }

    function test_everyAction_rejectsWrongAction() public {
        for (uint8 i; i < N_ACTIONS; ++i) {
            (, bytes memory params) = _spec(i);
            (bytes32 other,) = _spec((i + 1) % N_ACTIONS);
            QillVault.OwnerAuth memory a = _signFor(ownerPk, block.chainid, address(vault), other, params, vault.ownerNonce(), uint64(block.timestamp + 1));
            vm.expectRevert(QillVault.BadSignature.selector);
            _invoke(i, a);
        }
    }

    function test_everyAction_rejectsWrongParams() public {
        // a valid PAUSE-shaped signature over different params must not authorise WITHDRAW of a larger amount
        QillVault.OwnerAuth memory a = _owner(QillMessage.WITHDRAW, abi.encode(attacker, address(tokA), 1 * ONE));
        vm.expectRevert(QillVault.BadSignature.selector);
        vault.withdraw(a, attacker, address(tokA), 2 * ONE);
        vm.expectRevert(QillVault.BadSignature.selector);
        vault.withdraw(a, executor, address(tokA), 1 * ONE);
    }

    function test_inactivePrecompile_reverts() public {
        vm.etch(PQC_ADDR, "");
        QillVault.OwnerAuth memory a = _owner(QillMessage.PAUSE, "");
        vm.expectRevert();
        vault.pause(a);
        assertFalse(vault.paused());
    }

    function test_withdraw_tokenAndNative() public {
        address to = makeAddr("safe");
        vault.withdraw(_owner(QillMessage.WITHDRAW, abi.encode(to, address(tokA), 7 * ONE)), to, address(tokA), 7 * ONE);
        assertEq(tokA.balanceOf(to), 7 * ONE);
        vault.withdraw(_owner(QillMessage.WITHDRAW, abi.encode(to, address(0), 1 ether)), to, address(0), 1 ether);
        assertEq(to.balance, 1 ether);
    }

    function test_rotateOwnerKey_oldKeyStopsWorking() public {
        bytes memory newPk = _fakePubkey(0x33);
        vault.rotateOwnerKey(_owner(QillMessage.ROTATE_OWNER_KEY, abi.encode(keccak256(newPk))), keccak256(newPk));
        QillVault.OwnerAuth memory old = _owner(QillMessage.PAUSE, "");
        vm.expectRevert(QillVault.WrongKey.selector);
        vault.pause(old);
        vault.pause(_signFor(newPk, block.chainid, address(vault), QillMessage.PAUSE, "", vault.ownerNonce(), uint64(block.timestamp + 1)));
        assertTrue(vault.paused());
    }

    function test_qDay_isIrreversible() public {
        vault.qDay(_owner(QillMessage.Q_DAY, ""));
        assertTrue(vault.qDayFrozen());
        assertTrue(vault.paused());
        assertEq(vault.executor(), address(0));

        QillVault.OwnerAuth memory r = _owner(QillMessage.RESUME, "");
        vm.expectRevert(QillVault.IsFrozen.selector);
        vault.resume(r);
        QillVault.OwnerAuth memory s = _owner(QillMessage.SET_EXECUTOR, abi.encode(executor));
        vm.expectRevert(QillVault.IsFrozen.selector);
        vault.setExecutor(s, executor);
        QillVault.MandateParams memory p = _defaultMandate(keccak256("after"));
        QillVault.OwnerAuth memory c = _owner(QillMessage.CREATE_MANDATE, abi.encode(p));
        vm.expectRevert(QillVault.IsFrozen.selector);
        vault.createMandate(c, p);
        // owner can still rescue funds with the PQ key
        address safe = makeAddr("safe");
        vault.withdraw(_owner(QillMessage.WITHDRAW, abi.encode(safe, address(tokA), ONE)), safe, address(tokA), ONE);
        assertEq(tokA.balanceOf(safe), ONE);
    }

    // ---------------------------------------------------------------- mandate validation

    function _expectBadMandate(QillVault.MandateParams memory p, bytes memory err) internal {
        QillVault.OwnerAuth memory a = _owner(QillMessage.CREATE_MANDATE, abi.encode(p));
        vm.expectRevert(err);
        vault.createMandate(a, p);
    }

    function test_mandate_validation() public {
        QillVault.MandateParams memory p;

        p = _defaultMandate(MID);
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.MandateExists.selector));

        p = _defaultMandate(bytes32(0));
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(0)));

        p = _defaultMandate(keccak256("x"));
        p.expiry = uint64(block.timestamp + 31 days);
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(1)));
        p.expiry = uint64(block.timestamp);
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(1)));

        p = _defaultMandate(keccak256("x"));
        p.pools = new address[](0);
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(3)));

        p = _defaultMandate(keccak256("x"));
        p.pools[0] = attacker;
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.PoolNotAllowed.selector));

        p = _defaultMandate(keccak256("x"));
        p.tokens[1] = attacker;
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.TokenNotAllowed.selector));

        p = _defaultMandate(keccak256("x"));
        p.tokens[1] = p.tokens[0];
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(6)));

        p = _defaultMandate(keccak256("x"));
        p.perTradeCap[0] = 0;
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(7)));

        p = _defaultMandate(keccak256("x"));
        p.softLimit[0] = p.perTradeCap[0] + 1;
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(7)));

        p = _defaultMandate(keccak256("x"));
        p.perTradeCap[0] = p.dailyCap[0] + 1;
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(7)));

        p = _defaultMandate(keccak256("x"));
        p.dailyCap = new uint256[](1);
        _expectBadMandate(p, abi.encodeWithSelector(QillVault.BadMandate.selector, uint8(4)));
    }

    function test_revokeMandate_twiceFails() public {
        vault.revokeMandate(_owner(QillMessage.REVOKE_MANDATE, abi.encode(MID)), MID);
        QillVault.OwnerAuth memory a = _owner(QillMessage.REVOKE_MANDATE, abi.encode(MID));
        vm.expectRevert(QillVault.MandateNotActive.selector);
        vault.revokeMandate(a, MID);
    }
}

contract QillVaultTradeTest is Base {
    function test_trade_happyPath_belowSoftLimit() public {
        (uint256 a0, uint256 b0,) = _vaultValue();
        vm.prank(executor);
        uint256 out = vault.trade(_tradeAB(10 * ONE), _noGuardian());
        (uint256 a1, uint256 b1,) = _vaultValue();
        assertEq(a0 - a1, 10 * ONE);
        assertEq(b1 - b0, out);
        assertGt(out, 9 * ONE);
        assertEq(tokA.allowance(address(vault), address(pool)), 0, "approval reset");
        (,,, uint256 spent,) = vault.limits(MID, address(tokA));
        assertEq(spent, 10 * ONE);
    }

    function test_trade_aboveSoftLimit_needsGuardian() public {
        QillVault.TradeParams memory t = _tradeAB(50 * ONE);
        vm.prank(executor);
        vm.expectRevert(QillVault.GuardianRequired.selector);
        vault.trade(t, _noGuardian());

        QillVault.OwnerAuth memory g = _guardian(t);
        vm.prank(executor);
        vault.trade(t, g);
        assertEq(vault.guardianNonce(), 1);

        // replaying the same guardian approval fails
        vm.prank(executor);
        vm.expectRevert(QillVault.BadNonce.selector);
        vault.trade(t, g);
    }

    function test_trade_guardianSigBoundToExactParams() public {
        QillVault.TradeParams memory t = _tradeAB(50 * ONE);
        QillVault.OwnerAuth memory g = _guardian(t);
        t.amountIn = 60 * ONE;
        vm.prank(executor);
        vm.expectRevert(QillVault.BadSignature.selector);
        vault.trade(t, g);
    }

    function test_trade_ownerKeyCannotStandInForGuardian() public {
        QillVault.TradeParams memory t = _tradeAB(50 * ONE);
        QillVault.OwnerAuth memory g = _signFor(ownerPk, block.chainid, address(vault), QillMessage.GUARDIAN_APPROVE_TRADE, abi.encode(t), 0, uint64(block.timestamp + 60));
        vm.prank(executor);
        vm.expectRevert(QillVault.WrongKey.selector);
        vault.trade(t, g);
    }

    function test_trade_guardianExpired() public {
        QillVault.TradeParams memory t = _tradeAB(50 * ONE);
        QillVault.OwnerAuth memory g = _guardian(t);
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(executor);
        vm.expectRevert(QillVault.SignatureExpired.selector);
        vault.trade(t, g);
    }

    function test_trade_nonExecutor() public {
        vm.prank(attacker);
        vm.expectRevert(QillVault.NotExecutor.selector);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
    }

    function test_trade_paused() public {
        vault.pause(_owner(QillMessage.PAUSE, ""));
        vm.prank(executor);
        vm.expectRevert(QillVault.IsPaused.selector);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
        vault.resume(_owner(QillMessage.RESUME, ""));
        vm.prank(executor);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
    }

    function test_trade_frozen() public {
        vault.qDay(_owner(QillMessage.Q_DAY, ""));
        // executor was cleared; even the old executor cannot trade
        vm.prank(executor);
        vm.expectRevert(QillVault.NotExecutor.selector);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
    }

    function test_trade_expiredMandate() public {
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(executor);
        vm.expectRevert(QillVault.MandateExpired.selector);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
    }

    function test_trade_revokedMandate() public {
        vault.revokeMandate(_owner(QillMessage.REVOKE_MANDATE, abi.encode(MID)), MID);
        vm.prank(executor);
        vm.expectRevert(QillVault.MandateNotActive.selector);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
    }

    function test_trade_unknownMandate() public {
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.mandateId = keccak256("nope");
        vm.prank(executor);
        vm.expectRevert(QillVault.MandateNotActive.selector);
        vault.trade(t, _noGuardian());
    }

    function test_trade_wrongPool() public {
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.pool = address(pool2); // globally allowed, not in mandate
        vm.prank(executor);
        vm.expectRevert(QillVault.PoolNotAllowed.selector);
        vault.trade(t, _noGuardian());

        t.pool = attacker;
        vm.prank(executor);
        vm.expectRevert(QillVault.PoolNotAllowed.selector);
        vault.trade(t, _noGuardian());
    }

    function test_trade_poolRemovedFromGlobalAllowlist() public {
        vault.setAllowlist(_owner(QillMessage.SET_ALLOWLIST, abi.encode(QillVault.ListKind.Pool, address(pool), false)), QillVault.ListKind.Pool, address(pool), false);
        vm.prank(executor);
        vm.expectRevert(QillVault.PoolNotAllowed.selector);
        vault.trade(_tradeAB(10 * ONE), _noGuardian());
    }

    function test_trade_wrongTokens() public {
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.tokenOut = t.tokenIn;
        vm.prank(executor);
        vm.expectRevert(QillVault.TokenNotAllowed.selector);
        vault.trade(t, _noGuardian());
        t = _tradeAB(10 * ONE);
        t.tokenOut = attacker;
        vm.prank(executor);
        vm.expectRevert(QillVault.TokenNotAllowed.selector);
        vault.trade(t, _noGuardian());
    }

    function test_trade_overPerTradeCap() public {
        QillVault.TradeParams memory t = _tradeAB(100 * ONE + 1);
        QillVault.OwnerAuth memory g = _guardian(t); // even with guardian approval
        vm.prank(executor);
        vm.expectRevert(QillVault.OverPerTradeCap.selector);
        vault.trade(t, g);
    }

    function test_trade_overDailyCap_andResetNextUtcDay() public {
        for (uint256 i; i < 6; ++i) {
            vm.prank(executor);
            vault.trade(_tradeAB(40 * ONE), _noGuardian()); // 240 total
        }
        vm.prank(executor);
        vm.expectRevert(QillVault.OverDailyCap.selector);
        vault.trade(_tradeAB(11 * ONE), _noGuardian());
        vm.prank(executor);
        vault.trade(_tradeAB(10 * ONE), _noGuardian()); // exactly 250

        // jump to the start of the next UTC day
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        vm.prank(executor);
        vault.trade(_tradeAB(40 * ONE), _noGuardian());
        (,,, uint256 spent,) = vault.limits(MID, address(tokA));
        assertEq(spent, 40 * ONE);
    }

    function test_trade_minOutNotMet_byPool() public {
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.minOut = 10 * ONE; // more than the pool can give after fees
        vm.prank(executor);
        vm.expectRevert(MockPool.Slippage.selector);
        vault.trade(t, _noGuardian());
    }

    function _mandateWithPool(address p, bytes32 id) internal {
        vault.setAllowlist(_owner(QillMessage.SET_ALLOWLIST, abi.encode(QillVault.ListKind.Pool, p, true)), QillVault.ListKind.Pool, p, true);
        QillVault.MandateParams memory m = _defaultMandate(id);
        m.pools[0] = p;
        vault.createMandate(_owner(QillMessage.CREATE_MANDATE, abi.encode(m)), m);
    }

    function test_trade_outputMustLandInVault() public {
        StealingPool sp = new StealingPool(attacker);
        tokB.transfer(address(sp), 1000 * ONE);
        _mandateWithPool(address(sp), keccak256("steal"));
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.mandateId = keccak256("steal");
        t.pool = address(sp);
        vm.prank(executor);
        vm.expectRevert(QillVault.MinOutNotMet.selector);
        vault.trade(t, _noGuardian());
        assertEq(tokB.balanceOf(attacker), 0);
    }

    function test_trade_lyingPoolCaught() public {
        LyingPool lp = new LyingPool();
        tokB.transfer(address(lp), 1000 * ONE);
        _mandateWithPool(address(lp), keccak256("lie"));
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.mandateId = keccak256("lie");
        t.pool = address(lp);
        t.minOut = 9 * ONE;
        vm.prank(executor);
        vm.expectRevert(QillVault.MinOutNotMet.selector);
        vault.trade(t, _noGuardian());
    }

    function test_trade_poolCannotPullMoreThanApproved() public {
        GreedyPool gp = new GreedyPool();
        tokB.transfer(address(gp), 1000 * ONE);
        _mandateWithPool(address(gp), keccak256("greedy"));
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.mandateId = keccak256("greedy");
        t.pool = address(gp);
        vm.prank(executor);
        vm.expectRevert(); // MockERC20.InsufficientAllowance
        vault.trade(t, _noGuardian());
    }

    function test_trade_reentrancyBlocked() public {
        ReentrantPool rp = new ReentrantPool();
        _mandateWithPool(address(rp), bytes32(uint256(1)));
        QillVault.TradeParams memory t = _tradeAB(10 * ONE);
        t.mandateId = bytes32(uint256(1));
        t.pool = address(rp);
        (uint256 a0, uint256 b0, uint256 n0) = _vaultValue();
        for (uint8 mode; mode < 2; ++mode) {
            rp.arm(vault, mode);
            vm.prank(executor);
            vm.expectRevert(QillVault.Reentrancy.selector);
            vault.trade(t, _noGuardian());
        }
        (uint256 a1, uint256 b1, uint256 n1) = _vaultValue();
        assertEq(a0, a1);
        assertEq(b0, b1);
        assertEq(n0, n1);
    }

    // ---------------------------------------------------------------- fuzz

    /// Any caller other than the executor can never trade, whatever the params.
    function testFuzz_trade_nonExecutorAlwaysReverts(address caller, QillVault.TradeParams memory t) public {
        vm.assume(caller != executor);
        (uint256 a0, uint256 b0, uint256 n0) = _vaultValue();
        vm.prank(caller);
        vm.expectRevert(QillVault.NotExecutor.selector);
        vault.trade(t, _noGuardian());
        (uint256 a1, uint256 b1, uint256 n1) = _vaultValue();
        assertEq(a0 + b0 + n0, a1 + b1 + n1);
    }

    /// Junk owner signatures from any caller never move funds or change state.
    function testFuzz_withdraw_junkSignature(address caller, bytes calldata sig, uint256 nonce, uint64 expiry, address to, uint256 amount)
        public
    {
        QillVault.OwnerAuth memory a = QillVault.OwnerAuth(ownerPk, sig, nonce, expiry);
        (uint256 a0,,) = _vaultValue();
        vm.prank(caller);
        try vault.withdraw(a, to, address(tokA), amount) {
            fail();
        } catch {}
        (uint256 a1,,) = _vaultValue();
        assertEq(a0, a1);
        assertEq(vault.ownerNonce(), 1);
    }

    function testFuzz_executor_tradeWithinCaps(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e6, 40 * ONE);
        (uint256 a0,,) = _vaultValue();
        vm.prank(executor);
        vault.trade(_tradeAB(amountIn), _noGuardian());
        (uint256 a1,,) = _vaultValue();
        assertEq(a0 - a1, amountIn);
    }
}

contract QillMessageVectorsTest is Base {
    function test_crossLanguageVectors() public view {
        string memory json = vm.readFile("test/vectors/message.json");
        address verifying = vm.parseJsonAddress(json, ".verifyingContract");
        uint256 chainId = vm.parseJsonUint(json, ".chainId");
        bytes memory pk = vm.parseJsonBytes(json, ".publicKey");
        assertEq(pk.length, 2592);
        assertEq(keccak256(pk), vm.parseJsonBytes32(json, ".publicKeyHash"));
        for (uint256 i; i < 2; ++i) {
            string memory k = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 action = vm.parseJsonBytes32(json, string.concat(k, ".actionId"));
            bytes memory params = vm.parseJsonBytes(json, string.concat(k, ".params"));
            uint256 nonce = vm.parseJsonUint(json, string.concat(k, ".nonce"));
            uint64 expiry = uint64(vm.parseJsonUint(json, string.concat(k, ".expiry")));
            bytes memory expected = vm.parseJsonBytes(json, string.concat(k, ".message"));
            assertEq(QillMessage.encodeFor(chainId, verifying, action, params, nonce, expiry), expected);
            assertEq(vm.parseJsonBytes(json, string.concat(k, ".signature")).length, 4627);
        }
        assertEq(vm.parseJsonBytes32(json, ".vectors[0].actionId"), QillMessage.PAUSE);
        assertEq(vm.parseJsonBytes32(json, ".vectors[1].actionId"), QillMessage.WITHDRAW);
    }
}
