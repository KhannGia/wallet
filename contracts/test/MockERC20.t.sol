// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract MockERC20Test is Test {
    event Transfer(address indexed from, address indexed to, uint256 value);

    MockERC20 internal token;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        token = new MockERC20("Mock USD Coin", "USDC", 6);
    }

    function test_UsesSixDecimalsLikeUsdc() public view {
        assertEq(token.decimals(), 6);
    }

    function test_MintEmitsTransferFromZero() public {
        // The indexer treats a mint as a transfer from the zero address, so the
        // event shape matters as much as the balance.
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), alice, 1_000_000);

        token.mint(alice, 1_000_000);
        assertEq(token.balanceOf(alice), 1_000_000);
        assertEq(token.totalSupply(), 1_000_000);
    }

    function test_TransferMovesBalanceAndEmits() public {
        token.mint(alice, 1_000_000);

        vm.expectEmit(true, true, false, true);
        emit Transfer(alice, bob, 400_000);

        vm.prank(alice);
        // Returning true is part of the ERC-20 contract, so it is asserted
        // rather than discarded.
        assertTrue(token.transfer(bob, 400_000));

        assertEq(token.balanceOf(alice), 600_000);
        assertEq(token.balanceOf(bob), 400_000);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        token.mint(alice, 100);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MockERC20.InsufficientBalance.selector, alice, 100, 101)
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(bob, 101);
    }

    function testFuzz_TransferConservesTotalSupply(uint128 minted, uint128 sent) public {
        vm.assume(sent <= minted);
        token.mint(alice, minted);

        vm.prank(alice);
        assertTrue(token.transfer(bob, sent));

        assertEq(token.balanceOf(alice) + token.balanceOf(bob), token.totalSupply());
    }
}
