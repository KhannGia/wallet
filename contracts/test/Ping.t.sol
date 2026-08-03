// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ping} from "../src/Ping.sol";

contract PingTest is Test {
    event Pinged(address indexed caller, uint256 count);

    Ping internal ping;

    function setUp() public {
        ping = new Ping();
    }

    function test_CountStartsAtZero() public view {
        assertEq(ping.count(), 0);
    }

    function test_PingIncrementsAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Pinged(address(this), 1);

        assertEq(ping.ping(), 1);
        assertEq(ping.count(), 1);
    }

    function testFuzz_PingIsMonotonic(uint8 times) public {
        vm.assume(times > 0);

        for (uint256 i = 0; i < times; i++) {
            ping.ping();
        }

        assertEq(ping.count(), times);
    }
}
