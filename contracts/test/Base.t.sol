// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {QillVault} from "../src/QillVault.sol";
import {QillMessage} from "../src/libraries/QillMessage.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockPool} from "../src/mocks/MockPool.sol";
import {MockPQC} from "./mocks/TestMocks.sol";

abstract contract Base is Test {
    address constant PQC_ADDR = 0x0000000000000000000000000000000000000a01;
    uint256 constant CHAIN_ID = 9800;
    uint256 constant ONE = 1e18;

    QillVault vault;
    MockERC20 tokA;
    MockERC20 tokB;
    MockPool pool;
    MockPool pool2; // globally allowlisted, but not in the default mandate

    address executor = makeAddr("executor");
    address attacker = makeAddr("attacker");
    bytes ownerPk;
    bytes guardianPk;
    bytes32 constant MID = keccak256("mandate-1");

    function setUp() public virtual {
        vm.chainId(CHAIN_ID);
        vm.warp(1_800_000_000);
        vm.etch(PQC_ADDR, address(new MockPQC()).code);

        ownerPk = _fakePubkey(0x0A);
        guardianPk = _fakePubkey(0x6A);

        tokA = new MockERC20("Token A", "TKA", address(this), 1_000_000 * ONE);
        tokB = new MockERC20("Token B", "TKB", address(this), 1_000_000 * ONE);
        pool = new MockPool(address(tokA), address(tokB));
        pool2 = new MockPool(address(tokA), address(tokB));
        tokA.approve(address(pool), type(uint256).max);
        tokB.approve(address(pool), type(uint256).max);
        pool.addLiquidity(100_000 * ONE, 100_000 * ONE);
        tokA.approve(address(pool2), type(uint256).max);
        tokB.approve(address(pool2), type(uint256).max);
        pool2.addLiquidity(100_000 * ONE, 100_000 * ONE);

        address[] memory toks = new address[](2);
        toks[0] = address(tokA);
        toks[1] = address(tokB);
        address[] memory pools = new address[](2);
        pools[0] = address(pool);
        pools[1] = address(pool2);
        vault = new QillVault(keccak256(ownerPk), keccak256(guardianPk), executor, toks, pools);

        tokA.transfer(address(vault), 10_000 * ONE);
        tokB.transfer(address(vault), 10_000 * ONE);
        vm.deal(address(vault), 5 ether);

        _createDefaultMandate();
    }

    // ------------------------------------------------------------ signing helpers

    function _fakePubkey(uint8 fill) internal pure returns (bytes memory pk) {
        pk = new bytes(2592);
        for (uint256 i; i < pk.length; ++i) pk[i] = bytes1(uint8((uint256(fill) + i) % 256));
    }

    function _mockSign(bytes memory pk, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(keccak256(pk), message)));
    }

    function _signFor(bytes memory pk, uint256 chainId, address verifying, bytes32 action, bytes memory params, uint256 nonce, uint64 expiry)
        internal
        pure
        returns (QillVault.OwnerAuth memory a)
    {
        bytes memory m = QillMessage.encodeFor(chainId, verifying, action, params, nonce, expiry);
        a = QillVault.OwnerAuth({pubkey: pk, signature: _mockSign(pk, m), nonce: nonce, expiry: expiry});
    }

    function _owner(bytes32 action, bytes memory params) internal view returns (QillVault.OwnerAuth memory) {
        return _signFor(ownerPk, block.chainid, address(vault), action, params, vault.ownerNonce(), uint64(block.timestamp + 1 hours));
    }

    function _guardian(QillVault.TradeParams memory t) internal view returns (QillVault.OwnerAuth memory) {
        return _signFor(
            guardianPk,
            block.chainid,
            address(vault),
            QillMessage.GUARDIAN_APPROVE_TRADE,
            abi.encode(t),
            vault.guardianNonce(),
            uint64(block.timestamp + 10 minutes)
        );
    }

    function _noGuardian() internal pure returns (QillVault.OwnerAuth memory a) {}

    // ------------------------------------------------------------ mandate helpers

    /// perTradeCap 100, dailyCap 250, softLimit 40 (both tokens), 7 days, pool only.
    function _defaultMandate(bytes32 id) internal view returns (QillVault.MandateParams memory p) {
        p.id = id;
        p.textHash = keccak256("Swap up to 100 A or B per trade, 250 per day, via pool 1, for 7 days.");
        p.rulesHash = keccak256("rules-json");
        p.expiry = uint64(block.timestamp + 7 days);
        p.pools = new address[](1);
        p.pools[0] = address(pool);
        p.tokens = new address[](2);
        p.tokens[0] = address(tokA);
        p.tokens[1] = address(tokB);
        p.perTradeCap = new uint256[](2);
        p.dailyCap = new uint256[](2);
        p.softLimit = new uint256[](2);
        for (uint256 i; i < 2; ++i) {
            p.perTradeCap[i] = 100 * ONE;
            p.dailyCap[i] = 250 * ONE;
            p.softLimit[i] = 40 * ONE;
        }
    }

    function _createDefaultMandate() internal {
        QillVault.MandateParams memory p = _defaultMandate(MID);
        vault.createMandate(_owner(QillMessage.CREATE_MANDATE, abi.encode(p)), p);
    }

    function _tradeAB(uint256 amountIn) internal view returns (QillVault.TradeParams memory t) {
        t = QillVault.TradeParams({
            mandateId: MID,
            pool: address(pool),
            tokenIn: address(tokA),
            tokenOut: address(tokB),
            amountIn: amountIn,
            minOut: 1
        });
    }

    function _vaultValue() internal view returns (uint256 a, uint256 b, uint256 n) {
        return (tokA.balanceOf(address(vault)), tokB.balanceOf(address(vault)), address(vault).balance);
    }
}
