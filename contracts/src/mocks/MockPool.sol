// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Min} from "../interfaces/IERC20Min.sol";
import {IQillPool} from "../interfaces/IQillPool.sol";

/// @notice Constant-product (x*y=k, 0.3% fee) pool for exactly two tokens.
/// @dev Anyone can add liquidity and nobody can ever remove it: no admin, no withdraw, nothing to drain.
contract MockPool is IQillPool {
    address public immutable token0;
    address public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;

    event LiquidityAdded(address indexed from, uint256 amount0, uint256 amount1);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to);

    error BadToken();
    error ZeroAmount();
    error Slippage();
    error NoLiquidity();
    error TransferFailed();

    constructor(address t0, address t1) {
        if (t0 == t1 || t0 == address(0) || t1 == address(0)) revert BadToken();
        token0 = t0;
        token1 = t1;
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external {
        if (!IERC20Min(token0).transferFrom(msg.sender, address(this), amount0)) revert TransferFailed();
        if (!IERC20Min(token1).transferFrom(msg.sender, address(this), amount1)) revert TransferFailed();
        reserve0 += amount0;
        reserve1 += amount1;
        emit LiquidityAdded(msg.sender, amount0, amount1);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = _reserves(tokenIn, tokenOut);
        if (rIn == 0 || rOut == 0) revert NoLiquidity();
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 out)
    {
        if (amountIn == 0) revert ZeroAmount();
        out = quote(tokenIn, tokenOut, amountIn);
        if (out < minOut || out == 0) revert Slippage();
        if (!IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();
        if (tokenIn == token0) {
            reserve0 += amountIn;
            reserve1 -= out;
        } else {
            reserve1 += amountIn;
            reserve0 -= out;
        }
        if (!IERC20Min(tokenOut).transfer(to, out)) revert TransferFailed();
        emit Swap(msg.sender, tokenIn, amountIn, out, to);
    }

    function _reserves(address tokenIn, address tokenOut) private view returns (uint256, uint256) {
        if (tokenIn == token0 && tokenOut == token1) return (reserve0, reserve1);
        if (tokenIn == token1 && tokenOut == token0) return (reserve1, reserve0);
        revert BadToken();
    }
}
