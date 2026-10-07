import {
    encodeFunctionData,
    parseAbi,
    type Address,
    type LocalAccount,
    type PublicClient,
} from "viem";
import {
    entryPoint08Abi,
    entryPoint08Address,
    getUserOperationTypedData,
    toSmartAccount,
} from "viem/account-abstraction";

/**
 * The parts of SmartAccount and AccountFactory the backend calls, declared by
 * hand for the same reason as the vault's: a running service should not need
 * forge output, only tests should.
 */
export const smartAccountAbi = parseAbi([
    "function execute(address target, uint256 value, bytes data)",
    "struct Call { address target; uint256 value; bytes data; }",
    "function executeBatch(Call[] calls)",
    "function owner() view returns (address)",
]);

export const accountFactoryAbi = parseAbi([
    "function createAccount(address owner, uint256 salt) returns (address)",
    "function getAddress(address owner, uint256 salt) view returns (address)",
]);

/**
 * A SmartAccount as viem's bundler client understands it: how to find its
 * address, how to deploy it on first use, how to encode calls, and how its
 * owner signs.
 *
 * The owner key signs the EntryPoint v0.8 userOpHash as EIP-712 typed data --
 * the digest the contract checks with no message prefix. Everything else about
 * an operation (gas limits, fees, the nonce) the bundler client fills in.
 */
export async function toWalletSmartAccount(params: {
    client: PublicClient;
    owner: LocalAccount;
    factory: Address;
    /** Lets one owner hold several accounts. */
    salt?: bigint;
    /**
     * An existing account's address. Needed once its owner has changed --
     * after a recovery, say -- because the factory derives addresses from the
     * owner the account was created with, not the one it has now.
     */
    address?: Address;
}) {
    const { client, owner, factory } = params;
    const salt = params.salt ?? 0n;
    const entryPoint = {
        abi: entryPoint08Abi,
        address: entryPoint08Address,
        version: "0.8",
    } as const;

    // The address is fixed by owner and salt before anything is deployed; the
    // factory computes it with the same CREATE2 inputs it deploys with.
    const address =
        params.address ??
        (await client.readContract({
            address: factory,
            abi: accountFactoryAbi,
            functionName: "getAddress",
            args: [owner.address, salt],
        }));

    return toSmartAccount({
        client,
        entryPoint,
        extend: { owner },

        async getAddress() {
            return address;
        },

        // One sequence, key 0: operations run in the order they were signed,
        // as an ordinary account's transactions do.
        //
        // The key viem passes in is deliberately ignored. Its wrapper draws a
        // fresh, time-based key for every operation, so each is the first in
        // its own sequence and they may land in any order -- useful for
        // parallel work, wrong for a wallet where a payment may depend on the
        // one before it.
        async getNonce() {
            return client.readContract({
                address: entryPoint.address,
                abi: entryPoint.abi,
                functionName: "getNonce",
                args: [address, 0n],
            });
        },

        // Sent as the first operation's initCode. The EntryPoint calls the
        // factory only while the account has no code; afterwards it is ignored.
        async getFactoryArgs() {
            return {
                factory,
                factoryData: encodeFunctionData({
                    abi: accountFactoryAbi,
                    functionName: "createAccount",
                    args: [owner.address, salt],
                }),
            };
        },

        async encodeCalls(calls) {
            if (calls.length === 1) {
                const [call] = calls;
                return encodeFunctionData({
                    abi: smartAccountAbi,
                    functionName: "execute",
                    args: [call!.to, call!.value ?? 0n, call!.data ?? "0x"],
                });
            }
            return encodeFunctionData({
                abi: smartAccountAbi,
                functionName: "executeBatch",
                args: [
                    calls.map((call) => ({
                        target: call.to,
                        value: call.value ?? 0n,
                        data: call.data ?? "0x",
                    })),
                ],
            });
        },

        // Stands in for the real signature while the bundler estimates gas: the
        // right length and shape, so validation costs what it really will. It
        // recovers to nobody, and the account reports that as a failed
        // signature rather than reverting -- which estimation tolerates.
        async getStubSignature() {
            return "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";
        },

        async signUserOperation(parameters) {
            const { chainId = client.chain?.id, ...userOperation } = parameters;
            if (chainId === undefined) throw new Error("no chain id to sign the operation for");
            return owner.signTypedData(
                getUserOperationTypedData({
                    chainId,
                    entryPointAddress: entryPoint.address,
                    userOperation: { ...userOperation, sender: address },
                }),
            );
        },

        // ERC-1271 message signing is not implemented by the contract yet, so
        // refuse rather than return a signature nothing will accept.
        async signMessage() {
            throw new Error("SmartAccount does not support message signing yet");
        },
        async signTypedData() {
            throw new Error("SmartAccount does not support typed-data signing yet");
        },
    });
}
