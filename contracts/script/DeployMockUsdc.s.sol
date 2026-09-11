// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Deploys the devnet token the indexer watches. Local chains only --
///         on a real network the wallet watches USDC and deploys nothing.
contract DeployMockUsdc is Script {
    function run() external returns (MockERC20 token) {
        vm.startBroadcast();
        token = new MockERC20("Mock USD Coin", "USDC", 6);
        vm.stopBroadcast();
    }
}
