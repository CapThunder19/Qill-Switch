// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal swap interface the vault speaks to approved pools.
interface IQillPool {
    /// @dev Pulls exactly `amountIn` of `tokenIn` from msg.sender and sends the output to `to`.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
}
