// The smart account's client side lives in the shared package, so the browser
// builds and signs operations with exactly the code the backend tests drive.
export {
    accountFactoryAbi,
    encodeSessionCall,
    EXECUTE_USER_OP_SELECTOR,
    smartAccountAbi,
    toSessionAccount,
    toWalletSmartAccount,
} from "@wallet/shared";
