import { concat, keccak256, numberToHex, toHex, type Hex } from "viem";

/**
 * A Merkle sum tree: every node carries a hash and the total of the balances
 * beneath it, and its hash commits to both children's hashes and totals.
 *
 * A plain Merkle tree proves a user's balance is in a list. It cannot prove
 * the published total is the sum of that list -- the platform could publish a
 * total smaller than what it owes. Here the root's sum is the total, and a
 * user walking their proof up to the root adds every sibling's sum on the
 * way: if any node anywhere had been given a smaller total than its children
 * add up to, the hashes would not match. Sums are unsigned, so no branch can
 * hide a debt behind a negative balance.
 *
 * A leaf can never be passed off as a node, or a node as a leaf: they hash
 * inputs of different lengths (97 bytes and 129), and each starts with its own
 * tag byte besides -- the tag is what keeps that true if either layout changes.
 */

export const MAX_SUM = 2n ** 256n - 1n;

const LEAF_TAG: Hex = "0x00";
const NODE_TAG: Hex = "0x01";

export interface SumNode {
    hash: Hex;
    sum: bigint;
}

export interface Leaf {
    /** 32 random bytes, fresh for every snapshot, known only to the user. */
    salt: Hex;
    accountId: bigint;
    amount: bigint;
}

/** One step up: the sibling at this level, and which side of us it sits on. */
export interface ProofStep {
    hash: Hex;
    sum: bigint;
    side: "left" | "right";
}

export interface SumProof {
    leaf: Leaf;
    path: ProofStep[];
}

/** Padding for a level with an odd number of nodes. It owes nobody anything. */
export const EMPTY_NODE: SumNode = { hash: keccak256(toHex("wallet.reserves.empty")), sum: 0n };

const word = (value: bigint): Hex => numberToHex(value, { size: 32 });

function checkSum(value: bigint, what: string): void {
    if (value < 0n || value > MAX_SUM) throw new RangeError(`${what} must be a uint256, got ${value}`);
}

/** Exactly 32 bytes: a shorter or longer value would shift every byte after it in the hashed input. */
function checkWord(value: string, what: string): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError(`${what} must be 32 bytes of hex`);
}

export function hashLeaf(leaf: Leaf): SumNode {
    checkSum(leaf.amount, "amount");
    checkSum(leaf.accountId, "account id");
    checkWord(leaf.salt, "salt");
    return {
        hash: keccak256(concat([LEAF_TAG, leaf.salt, word(leaf.accountId), word(leaf.amount)])),
        sum: leaf.amount,
    };
}

export function hashNode(left: SumNode, right: SumNode): SumNode {
    const sum = left.sum + right.sum;
    checkWord(left.hash, "left hash");
    checkWord(right.hash, "right hash");
    checkSum(left.sum, "left sum");
    checkSum(right.sum, "right sum");
    checkSum(sum, "sum");
    return {
        hash: keccak256(concat([NODE_TAG, left.hash, word(left.sum), right.hash, word(right.sum)])),
        sum,
    };
}

export interface SumTree {
    root: SumNode;
    /** Levels from the leaves (0) up to the root, each already padded to even length. */
    levels: SumNode[][];
    /** The leaves, in the order they sit in the tree. */
    leaves: Leaf[];
}

/**
 * Builds the tree. Leaves are ordered by their hash: salted, that order is
 * random, so a leaf's position says nothing about which account it is.
 */
export function buildSumTree(input: Leaf[]): SumTree {
    if (input.length === 0) return { root: EMPTY_NODE, levels: [[EMPTY_NODE]], leaves: [] };

    const hashed = input.map((leaf) => ({ leaf, node: hashLeaf(leaf) }));
    hashed.sort((a, b) => (a.node.hash < b.node.hash ? -1 : a.node.hash > b.node.hash ? 1 : 0));

    const levels: SumNode[][] = [];
    let level = hashed.map((entry) => entry.node);
    while (level.length > 1) {
        if (level.length % 2 === 1) level = [...level, EMPTY_NODE];
        levels.push(level);
        const next: SumNode[] = [];
        for (let i = 0; i < level.length; i += 2) next.push(hashNode(level[i]!, level[i + 1]!));
        level = next;
    }
    levels.push(level);

    return { root: level[0]!, levels, leaves: hashed.map((entry) => entry.leaf) };
}

/** The proof for the leaf of `accountId`, or undefined if it has none. */
export function proveLeaf(tree: SumTree, accountId: bigint): SumProof | undefined {
    let index = tree.leaves.findIndex((leaf) => leaf.accountId === accountId);
    if (index === -1) return undefined;
    const leaf = tree.leaves[index]!;

    const path: ProofStep[] = [];
    for (const level of tree.levels.slice(0, -1)) {
        const isLeft = index % 2 === 0;
        const sibling = level[isLeft ? index + 1 : index - 1]!;
        path.push({ hash: sibling.hash, sum: sibling.sum, side: isLeft ? "right" : "left" });
        index = Math.floor(index / 2);
    }
    return { leaf, path };
}

export type VerifyResult = { valid: true; root: SumNode } | { valid: false; reason: string };

/**
 * The root a proof leads to: the leaf, hashed, then combined with each sibling
 * in turn. Throws on anything malformed. A verifier looks this root up where
 * it was published, rather than trusting whichever root came with the proof.
 */
export function computeSumRoot(proof: SumProof): SumNode {
    let node = hashLeaf(proof.leaf);
    for (const step of proof.path) {
        if (step.side !== "left" && step.side !== "right") {
            throw new RangeError(`a step's side is ${String(step.side)}`);
        }
        const sibling = { hash: step.hash, sum: step.sum };
        node = step.side === "left" ? hashNode(sibling, node) : hashNode(node, sibling);
    }
    return node;
}

/**
 * Walks a proof up to the root it implies, and compares that with the root
 * the platform published. Everything a user needs is in the proof and the
 * published root; nothing here trusts the platform.
 */
export function verifySumProof(proof: SumProof, published: SumNode): VerifyResult {
    let node: SumNode;
    try {
        node = computeSumRoot(proof);
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (node.hash.toLowerCase() !== published.hash.toLowerCase()) {
        return { valid: false, reason: "the proof leads to a different root" };
    }
    if (node.sum !== published.sum) {
        return { valid: false, reason: `the proof sums to ${node.sum}, the published total is ${published.sum}` };
    }
    return { valid: true, root: node };
}

/** A proof as JSON carries it: integers as decimal strings, which survive any parser. */
export interface SumProofJson {
    leaf: { salt: string; accountId: string; amount: string };
    path: { hash: string; sum: string; side: string }[];
}

export function sumProofToJson(proof: SumProof): SumProofJson {
    return {
        leaf: {
            salt: proof.leaf.salt,
            accountId: proof.leaf.accountId.toString(),
            amount: proof.leaf.amount.toString(),
        },
        path: proof.path.map((step) => ({ hash: step.hash, sum: step.sum.toString(), side: step.side })),
    };
}

const decimal = (value: unknown, what: string): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new RangeError(`${what} must be a non-negative integer as a decimal string`);
    }
    return BigInt(value);
};

/** Parses a proof from untrusted JSON, refusing anything malformed rather than coercing it. */
export function sumProofFromJson(json: unknown): SumProof {
    const input = json as Partial<SumProofJson> | null;
    if (input === null || typeof input !== "object" || typeof input.leaf !== "object" || !Array.isArray(input.path)) {
        throw new RangeError("a proof has a leaf and a path");
    }
    const salt = String(input.leaf.salt);
    checkWord(salt, "salt");
    return {
        leaf: {
            salt: salt as Hex,
            accountId: decimal(input.leaf.accountId, "account id"),
            amount: decimal(input.leaf.amount, "amount"),
        },
        path: input.path.map((step, index) => {
            checkWord(String(step.hash), `step ${index} hash`);
            if (step.side !== "left" && step.side !== "right") throw new RangeError(`step ${index} side must be left or right`);
            return { hash: step.hash as Hex, sum: decimal(step.sum, `step ${index} sum`), side: step.side };
        }),
    };
}
