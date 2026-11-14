// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IQorePQC} from "./interfaces/IQorePQC.sol";
import {IQillPool} from "./interfaces/IQillPool.sol";
import {IERC20Min} from "./interfaces/IERC20Min.sol";
import {QillMessage} from "./libraries/QillMessage.sol";

/// @title QillVault: an AI agent's treasury, bound by owner-signed ML-DSA-87 mandates
/// @notice Every action that grants power or moves money out needs an ML-DSA-87 signature by the owner,
///         verified on chain through QoreChain's `pqcVerify` precompile. There is no `msg.sender`-based
///         owner: a stolen ECDSA key cannot loosen anything. The only `msg.sender` check is `executor`
///         on `trade`, and trades are bounded by the mandate (pools, tokens, per-trade cap, daily cap,
///         expiry) and, above the soft limit, by a guardian ML-DSA-87 co-signature.
/// @dev Deliberately absent: selfdestruct, delegatecall, generic call(target, data), proxies/upgrades,
///      msg.sender-based ownership.
contract QillVault {
    // ---------------------------------------------------------------- constants

    IQorePQC public constant PQC = IQorePQC(0x0000000000000000000000000000000000000a01);
    uint64 public constant MAX_MANDATE_DURATION = 30 days;
    uint256 public constant MAX_MANDATE_TOKENS = 8;
    uint256 public constant MAX_MANDATE_POOLS = 8;

    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Active,
        Revoked
    }

    enum ListKind {
        Token,
        Pool
    }

    /// @notice Per-mandate, per-token limits (all amounts in token base units).
    struct TokenLimits {
        uint256 perTradeCap;
        uint256 dailyCap;
        uint256 softLimit;
        uint256 spentToday;
        uint64 dayIndex;
    }

    struct Mandate {
        bytes32 textHash;
        bytes32 rulesHash;
        uint64 expiry;
        Status status;
        address[] pools;
        address[] tokens;
    }

    /// @notice Owner-signed parameters for `createMandate` (signed as abi.encode(MandateParams)).
    struct MandateParams {
        bytes32 id;
        bytes32 textHash;
        bytes32 rulesHash;
        uint64 expiry;
        address[] pools;
        address[] tokens;
        uint256[] perTradeCap;
        uint256[] dailyCap;
        uint256[] softLimit;
    }

    /// @notice A trade proposed by the executor (guardian signs abi.encode(TradeParams) when required).
    struct TradeParams {
        bytes32 mandateId;
        address pool;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
    }

    /// @notice Common envelope for every owner-signed call.
    struct OwnerAuth {
        bytes pubkey;
        bytes signature;
        uint256 nonce;
        uint64 expiry;
    }

    // ---------------------------------------------------------------- state

    bytes32 public ownerKeyHash;
    bytes32 public guardianKeyHash;
    address public executor;
    uint256 public ownerNonce;
    uint256 public guardianNonce;
    bool public paused;
    bool public qDayFrozen;

    mapping(address => bool) public tokenAllowed;
    mapping(address => bool) public poolAllowed;

    mapping(bytes32 => Mandate) internal _mandates;
    mapping(bytes32 => mapping(address => TokenLimits)) public limits;
    mapping(bytes32 => mapping(address => bool)) public mandatePool;
    mapping(bytes32 => mapping(address => bool)) public mandateToken;
    bytes32[] public mandateIds;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- events

    event OwnerAction(bytes32 indexed action, uint256 indexed nonce, bytes32 paramsHash);
    event MandateCreated(bytes32 indexed id, bytes32 textHash, bytes32 rulesHash, uint64 expiry);
    event MandateRevoked(bytes32 indexed id);
    event Paused();
    event Resumed();
    event ExecutorSet(address indexed executor);
    event GuardianKeySet(bytes32 guardianKeyHash);
    event OwnerKeyRotated(bytes32 newOwnerKeyHash);
    event AllowlistSet(ListKind indexed kind, address indexed target, bool allowed);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);
    event QDay();
    event TradeExecuted(
        bytes32 indexed mandateId,
        address indexed pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bool guardianUsed
    );

    // ---------------------------------------------------------------- errors

    error WrongKey();
    error BadSignature();
    error BadNonce();
    error SignatureExpired();
    error IsPaused();
    error IsFrozen();
    error NotExecutor();
    error Reentrancy();
    error ZeroValue();
    error MandateExists();
    error MandateNotActive();
    error MandateExpired();
    error BadMandate(uint8 code);
    error PoolNotAllowed();
    error TokenNotAllowed();
    error OverPerTradeCap();
    error OverDailyCap();
    error GuardianRequired();
    error MinOutNotMet();
    error OverPulled();
    error TransferFailed();

    // ---------------------------------------------------------------- modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------- constructor

    constructor(
        bytes32 ownerKeyHash_,
        bytes32 guardianKeyHash_,
        address executor_,
        address[] memory tokens,
        address[] memory pools
    ) {
        if (ownerKeyHash_ == bytes32(0) || guardianKeyHash_ == bytes32(0)) revert ZeroValue();
        ownerKeyHash = ownerKeyHash_;
        guardianKeyHash = guardianKeyHash_;
        executor = executor_;
        emit ExecutorSet(executor_);
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroValue();
            tokenAllowed[tokens[i]] = true;
            emit AllowlistSet(ListKind.Token, tokens[i], true);
        }
        for (uint256 i; i < pools.length; ++i) {
            if (pools[i] == address(0)) revert ZeroValue();
            poolAllowed[pools[i]] = true;
            emit AllowlistSet(ListKind.Pool, pools[i], true);
        }
    }

    /// @notice Accepts native QOR deposits. Does nothing else.
    receive() external payable {}

    // ================================================================ owner-signed actions

    function createMandate(OwnerAuth calldata auth, MandateParams calldata p) external {
        if (qDayFrozen) revert IsFrozen();
        _authOwner(auth, QillMessage.CREATE_MANDATE, abi.encode(p));
        _createMandate(p);
    }

    function revokeMandate(OwnerAuth calldata auth, bytes32 id) external {
        _authOwner(auth, QillMessage.REVOKE_MANDATE, abi.encode(id));
        Mandate storage m = _mandates[id];
        if (m.status != Status.Active) revert MandateNotActive();
        m.status = Status.Revoked;
        emit MandateRevoked(id);
    }

    function pause(OwnerAuth calldata auth) external {
        _authOwner(auth, QillMessage.PAUSE, "");
        paused = true;
        emit Paused();
    }

    function resume(OwnerAuth calldata auth) external {
        if (qDayFrozen) revert IsFrozen();
        _authOwner(auth, QillMessage.RESUME, "");
        paused = false;
        emit Resumed();
    }

    function setExecutor(OwnerAuth calldata auth, address newExecutor) external {
        if (qDayFrozen) revert IsFrozen();
        _authOwner(auth, QillMessage.SET_EXECUTOR, abi.encode(newExecutor));
        executor = newExecutor;
        emit ExecutorSet(newExecutor);
    }

    function setGuardianKey(OwnerAuth calldata auth, bytes32 newGuardianKeyHash) external {
        if (newGuardianKeyHash == bytes32(0)) revert ZeroValue();
        _authOwner(auth, QillMessage.SET_GUARDIAN_KEY, abi.encode(newGuardianKeyHash));
        guardianKeyHash = newGuardianKeyHash;
        emit GuardianKeySet(newGuardianKeyHash);
    }

    function setAllowlist(OwnerAuth calldata auth, ListKind kind, address target, bool allowed) external {
        if (target == address(0)) revert ZeroValue();
        if (qDayFrozen && allowed) revert IsFrozen();
        _authOwner(auth, QillMessage.SET_ALLOWLIST, abi.encode(kind, target, allowed));
        if (kind == ListKind.Token) tokenAllowed[target] = allowed;
        else poolAllowed[target] = allowed;
        emit AllowlistSet(kind, target, allowed);
    }

    /// @notice Owner-signed withdrawal. `token == address(0)` withdraws native QOR.
    /// @dev Allowed even after Q-Day so the owner can move funds to safety with the PQ key.
    function withdraw(OwnerAuth calldata auth, address to, address token, uint256 amount) external nonReentrant {
        if (to == address(0) || amount == 0) revert ZeroValue();
        _authOwner(auth, QillMessage.WITHDRAW, abi.encode(to, token, amount));
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
        }
        emit Withdrawn(to, token, amount);
    }

    function rotateOwnerKey(OwnerAuth calldata auth, bytes32 newOwnerKeyHash) external {
        if (newOwnerKeyHash == bytes32(0)) revert ZeroValue();
        _authOwner(auth, QillMessage.ROTATE_OWNER_KEY, abi.encode(newOwnerKeyHash));
        ownerKeyHash = newOwnerKeyHash;
        emit OwnerKeyRotated(newOwnerKeyHash);
    }

    /// @notice Q-Day: freeze trading forever, pause, and drop the executor. Irreversible.
    function qDay(OwnerAuth calldata auth) external {
        _authOwner(auth, QillMessage.Q_DAY, "");
        qDayFrozen = true;
        paused = true;
        executor = address(0);
        emit QDay();
        emit Paused();
        emit ExecutorSet(address(0));
    }

    // ================================================================ executor trade

    function trade(TradeParams calldata t, OwnerAuth calldata guardian)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != executor || msg.sender == address(0)) revert NotExecutor();
        if (qDayFrozen) revert IsFrozen();
        if (paused) revert IsPaused();

        Mandate storage m = _mandates[t.mandateId];
        if (m.status != Status.Active) revert MandateNotActive();
        if (block.timestamp > m.expiry) revert MandateExpired();
        if (!mandatePool[t.mandateId][t.pool] || !poolAllowed[t.pool]) revert PoolNotAllowed();
        if (
            t.tokenIn == t.tokenOut || !mandateToken[t.mandateId][t.tokenIn] || !mandateToken[t.mandateId][t.tokenOut]
                || !tokenAllowed[t.tokenIn] || !tokenAllowed[t.tokenOut]
        ) revert TokenNotAllowed();
        if (t.amountIn == 0) revert ZeroValue();

        TokenLimits storage L = limits[t.mandateId][t.tokenIn];
        if (t.amountIn > L.perTradeCap) revert OverPerTradeCap();
        uint64 today = uint64(block.timestamp / 1 days);
        if (L.dayIndex != today) {
            L.dayIndex = today;
            L.spentToday = 0;
        }
        if (L.spentToday + t.amountIn > L.dailyCap) revert OverDailyCap();

        bool guardianUsed = t.amountIn > L.softLimit;
        if (guardianUsed) _authGuardian(guardian, t);

        L.spentToday += t.amountIn;

        IERC20Min tin = IERC20Min(t.tokenIn);
        IERC20Min tout = IERC20Min(t.tokenOut);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));

        if (!tin.approve(t.pool, t.amountIn)) revert TransferFailed();
        IQillPool(t.pool).swap(t.tokenIn, t.tokenOut, t.amountIn, t.minOut, address(this));
        if (!tin.approve(t.pool, 0)) revert TransferFailed();

        if (inBefore - tin.balanceOf(address(this)) > t.amountIn) revert OverPulled();
        uint256 outAfter = tout.balanceOf(address(this));
        amountOut = outAfter > outBefore ? outAfter - outBefore : 0;
        if (amountOut < t.minOut || amountOut == 0) revert MinOutNotMet();

        emit TradeExecuted(t.mandateId, t.pool, t.tokenIn, t.tokenOut, t.amountIn, amountOut, guardianUsed);
    }

    // ================================================================ views

    function getMandate(bytes32 id)
        external
        view
        returns (bytes32 textHash, bytes32 rulesHash, uint64 expiry, Status status, address[] memory pools, address[] memory tokens)
    {
        Mandate storage m = _mandates[id];
        return (m.textHash, m.rulesHash, m.expiry, m.status, m.pools, m.tokens);
    }

    function mandateCount() external view returns (uint256) {
        return mandateIds.length;
    }

    /// @notice The exact bytes the owner must sign for `action` with `params` at the current nonce.
    function ownerMessage(bytes32 action, bytes calldata params, uint64 expiry) external view returns (bytes memory) {
        return QillMessage.encode(action, params, ownerNonce, expiry);
    }

    /// @notice The exact bytes the guardian must sign to approve `t` at the current guardian nonce.
    function guardianMessage(TradeParams calldata t, uint64 expiry) external view returns (bytes memory) {
        return QillMessage.encode(QillMessage.GUARDIAN_APPROVE_TRADE, abi.encode(t), guardianNonce, expiry);
    }

    // ================================================================ internal

    function _authOwner(OwnerAuth calldata auth, bytes32 action, bytes memory params) internal {
        if (keccak256(auth.pubkey) != ownerKeyHash) revert WrongKey();
        if (auth.nonce != ownerNonce) revert BadNonce();
        if (auth.expiry < block.timestamp) revert SignatureExpired();
        bytes memory message = QillMessage.encode(action, params, auth.nonce, auth.expiry);
        if (!PQC.pqcVerify(auth.pubkey, auth.signature, message)) revert BadSignature();
        unchecked {
            ownerNonce = auth.nonce + 1;
        }
        emit OwnerAction(action, auth.nonce, keccak256(params));
    }

    function _authGuardian(OwnerAuth calldata g, TradeParams calldata t) internal {
        if (g.pubkey.length == 0) revert GuardianRequired();
        if (keccak256(g.pubkey) != guardianKeyHash) revert WrongKey();
        if (g.nonce != guardianNonce) revert BadNonce();
        if (g.expiry < block.timestamp) revert SignatureExpired();
        bytes memory message = QillMessage.encode(QillMessage.GUARDIAN_APPROVE_TRADE, abi.encode(t), g.nonce, g.expiry);
        if (!PQC.pqcVerify(g.pubkey, g.signature, message)) revert BadSignature();
        unchecked {
            guardianNonce = g.nonce + 1;
        }
    }

    function _createMandate(MandateParams calldata p) internal {
        if (p.id == bytes32(0)) revert BadMandate(0);
        if (_mandates[p.id].status != Status.None) revert MandateExists();
        if (p.expiry <= block.timestamp || p.expiry > block.timestamp + MAX_MANDATE_DURATION) revert BadMandate(1);
        uint256 nt = p.tokens.length;
        uint256 np = p.pools.length;
        if (nt < 2 || nt > MAX_MANDATE_TOKENS) revert BadMandate(2);
        if (np == 0 || np > MAX_MANDATE_POOLS) revert BadMandate(3);
        if (p.perTradeCap.length != nt || p.dailyCap.length != nt || p.softLimit.length != nt) revert BadMandate(4);

        for (uint256 i; i < np; ++i) {
            address pool = p.pools[i];
            if (!poolAllowed[pool]) revert PoolNotAllowed();
            if (mandatePool[p.id][pool]) revert BadMandate(5);
            mandatePool[p.id][pool] = true;
        }
        for (uint256 i; i < nt; ++i) {
            address token = p.tokens[i];
            if (!tokenAllowed[token]) revert TokenNotAllowed();
            if (mandateToken[p.id][token]) revert BadMandate(6);
            uint256 cap = p.perTradeCap[i];
            uint256 daily = p.dailyCap[i];
            uint256 soft = p.softLimit[i];
            // Every token must carry real limits: no zero caps, soft <= per-trade <= daily.
            if (cap == 0 || daily == 0 || soft > cap || cap > daily) revert BadMandate(7);
            mandateToken[p.id][token] = true;
            limits[p.id][token] = TokenLimits({perTradeCap: cap, dailyCap: daily, softLimit: soft, spentToday: 0, dayIndex: 0});
        }

        Mandate storage m = _mandates[p.id];
        m.textHash = p.textHash;
        m.rulesHash = p.rulesHash;
        m.expiry = p.expiry;
        m.status = Status.Active;
        m.pools = p.pools;
        m.tokens = p.tokens;
        mandateIds.push(p.id);
        emit MandateCreated(p.id, p.textHash, p.rulesHash, p.expiry);
    }
}
