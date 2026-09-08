// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @title A deliberately minimal ERC-20 for local development.
/// @notice Exists only so anvil emits real Transfer events for the indexer to
///         read. It is never deployed anywhere but a devnet: `mint` is
///         unrestricted, which would be a critical flaw in a real token.
///
///         The production target is USDC, which this project never deploys --
///         it only watches. That is why no audited ERC-20 library is pulled in
///         for this file: nothing of value ever depends on it.
contract MockERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowed, uint256 needed);
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    /// @notice Unrestricted on purpose. Devnet only.
    function mint(address to, uint256 value) external {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(msg.sender, allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance(from, balance, value);

        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }

        emit Transfer(from, to, value);
    }
}
