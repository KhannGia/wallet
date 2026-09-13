import { createPublicClient, http, type PublicClient } from "viem";

import { localChain } from "@wallet/shared";

/**
 * The chain client every service uses.
 *
 * Caching is switched off deliberately. viem holds block reads for its polling
 * interval by default, which is a sensible optimisation for most applications
 * and precisely wrong for this one: after a reorganisation the cache keeps
 * serving the old block hash, so the check for "is this still the block the
 * deposit arrived in" compares a stale hash against itself and reports that
 * nothing has changed.
 *
 * That failure is silent -- deposits from a replaced block would stay credited
 * forever. It cost an afternoon to find in the tests, where it presented as
 * flakiness rather than as a wrong answer.
 */
export function createChainClient(rpcUrl: string): PublicClient {
    return createPublicClient({
        chain: localChain,
        transport: http(rpcUrl),
        cacheTime: 0,
    });
}
