// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Min} from "../../src/interfaces/IERC20Min.sol";
import {IQillPool} from "../../src/interfaces/IQillPool.sol";
import {QillVault} from "../../src/QillVault.sol";

/// @notice Stand-in for the pqcVerify precompile, etched at 0x...0A01.
/// "Signature" valid iff sig == abi.encodePacked(keccak256(abi.encodePacked(keccak256(pubkey), message))).
/// Only the test signer (which knows the scheme and the message) can produce one; it binds pubkey + every message byte.
contract MockPQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return signature.length == 32
            && bytes32(signature) == keccak256(abi.encodePacked(keccak256(pubkey), message));
    }
}

/// @notice Sends swap output to an attacker instead of `to`.
contract StealingPool is IQillPool {
    address public immutable thief;
    constructor(address thief_) { thief = thief_; }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, address)
        external
        returns (uint256)
    {
        IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20Min(tokenOut).transfer(thief, amountIn);
        return amountIn;
    }

    function quote(address, address, uint256 a) external pure returns (uint256) { return a; }
}

/// @notice Ignores minOut and pays out only 1 wei.
contract LyingPool is IQillPool {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20Min(tokenOut).transfer(to, 1);
        return minOut; // lies about the output
    }

    function quote(address, address, uint256 a) external pure returns (uint256) { return a; }
}

/// @notice Tries to pull more than approved.
contract GreedyPool is IQillPool {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, address to)
        external
        returns (uint256)
    {
        IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn + 1);
        IERC20Min(tokenOut).transfer(to, amountIn);
        return amountIn;
    }

    function quote(address, address, uint256 a) external pure returns (uint256) { return a; }
}

/// @notice Re-enters the vault during swap.
contract ReentrantPool is IQillPool {
    QillVault public vault;
    uint8 public mode; // 0 = trade, 1 = withdraw

    function arm(QillVault v, uint8 m) external {
        vault = v;
        mode = m;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address)
        external
        returns (uint256)
    {
        QillVault.OwnerAuth memory junk;
        if (mode == 0) {
            QillVault.TradeParams memory t =
                QillVault.TradeParams(bytes32(uint256(1)), address(this), tokenIn, tokenOut, amountIn, minOut);
            vault.trade(t, junk);
        } else {
            vault.withdraw(junk, address(this), tokenIn, amountIn);
        }
        return 0;
    }

    function quote(address, address, uint256 a) external pure returns (uint256) { return a; }
}
