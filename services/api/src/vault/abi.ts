import { parseAbi } from "viem";

/**
 * The part of MultisigVault the backend talks to, declared by hand rather than
 * loaded from a compiled artifact: a running service should not depend on
 * forge output being present, only tests should.
 */
export const vaultAbi = parseAbi([
    "function nonce() view returns (uint256)",
    "function threshold() view returns (uint256)",
    "function isOwner(address) view returns (bool)",
    "function hashExecute(address to, uint256 value, bytes data, uint256 nonce_, uint256 deadline) view returns (bytes32)",
    "function execute(address to, uint256 value, bytes data, uint256 deadline, bytes[] signatures) returns (bytes)",
    "event Executed(uint256 indexed nonce, address indexed to, uint256 value, bytes data, bytes result)",
]);
