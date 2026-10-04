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

    // The timelock. Calls that are not a small hot-wallet top-up are queued,
    // wait out `delay`, and run through executeQueued.
    "function delay() view returns (uint256)",
    "function GRACE_PERIOD() view returns (uint256)",
    "function queue(address to, uint256 value, bytes data, uint256 deadline, bytes[] signatures) returns (uint256)",
    "function executeQueued(address to, uint256 value, bytes data, uint256 queuedNonce) returns (bytes)",
    "function cancel(address to, uint256 value, bytes data, uint256 queuedNonce)",
    "function queueId(uint256 queuedNonce, address to, uint256 value, bytes data) pure returns (bytes32)",
    "function queued(bytes32 id) view returns (uint256)",
    "function hotWallet() view returns (address)",
    "function remainingToday(address asset) view returns (uint256)",
    "event Queued(uint256 indexed nonce, address indexed to, uint256 value, bytes data, uint256 eta)",
    "event Cancelled(uint256 indexed nonce, address indexed by)",

    // Declared so a revert decodes to its name rather than to raw bytes: the
    // submitter tells "needs the queue" apart from "the call failed" by it.
    "error TimelockRequired()",
    "error NotQueued(uint256 nonce)",
    "error NotReady(uint256 eta, uint256 timestamp)",
    "error QueueExpired(uint256 eta, uint256 timestamp)",
    "error CallFailed(bytes returndata)",
    "error Expired(uint256 deadline, uint256 timestamp)",
]);
