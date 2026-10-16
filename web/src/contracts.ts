import { parseAbi } from "viem";

/**
 * The parts of the contracts the browser calls, declared by hand as the
 * backend's are: a page should not need compiler output to talk to the chain.
 */
export const guardianModuleAbi = parseAbi([
    "function guardians(address account) view returns (address[])",
    "function threshold(address account) view returns (uint256)",
    "function pending(address account) view returns (address newOwner, uint64 executableAt)",
    "function setGuardians(address[] guardians, uint256 threshold)",
    "function cancelRecovery()",
]);

export const accountAdminAbi = parseAbi([
    "function owner() view returns (address)",
    "function recoveryModule() view returns (address)",
    "struct Condition { uint8 param; uint8 operator; bytes32 value; }",
    "struct Permission { address target; bytes4 selector; Condition[] conditions; }",
    "struct SpendLimit { address token; uint256 limit; }",
    "function addSession(address key, uint48 validAfter, uint48 validUntil, uint256 nativeLimit, Permission[] permissions, SpendLimit[] limits)",
    "function revokeSession(address key)",
    "function sessions(address key) view returns (bool active, uint48 validAfter, uint48 validUntil, uint256 nativeLimit, uint256 nativeSpent)",
    "function tokenAllowances(address key, address token) view returns (bool capped, uint256 limit, uint256 spent)",
    "event SessionAdded(address indexed key, uint48 validAfter, uint48 validUntil)",
    "event SessionRevoked(address indexed key)",
]);

export const vaultAbi = parseAbi(["function cancel(address to, uint256 value, bytes data, uint256 nonce)"]);

/** transfer(address,uint256): what a session key is allowed to call on the token. */
export const TRANSFER_SELECTOR = "0xa9059cbb";

/** SmartAccount's condition operators, in the contract's order. */
export const Operator = { Equal: 0, LessOrEqual: 1, GreaterOrEqual: 2 } as const;
