import { parseAbi } from "viem";

/** The parts of GuardianModule the backend calls. */
export const guardianModuleAbi = parseAbi([
    "function nonce(address account) view returns (uint256)",
    "function threshold(address account) view returns (uint256)",
    "function isGuardian(address account, address guardian) view returns (bool)",
    "function pending(address account) view returns (address newOwner, uint64 executableAt)",
    "function EXECUTION_WINDOW() view returns (uint256)",
    "function hashRecovery(address account, address newOwner, uint256 nonce, uint256 deadline) view returns (bytes32)",
    "function hashCancel(address account, uint256 nonce, uint256 deadline) view returns (bytes32)",
    "function initiateRecovery(address account, address newOwner, uint256 deadline, bytes[] signatures)",
    "function executeRecovery(address account)",
    "function cancelRecoveryWithGuardians(address account, uint256 deadline, bytes[] signatures)",
    "event RecoveryStarted(address indexed account, address indexed newOwner, uint256 executableAt)",
    "event RecoveryExecuted(address indexed account, address indexed newOwner)",
    "event RecoveryCancelled(address indexed account, address indexed by)",
]);

export const recoverableAccountAbi = parseAbi([
    "function owner() view returns (address)",
    "function recoveryModule() view returns (address)",
]);
