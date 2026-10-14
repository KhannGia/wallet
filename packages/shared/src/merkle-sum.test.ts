import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { keccak256, numberToHex, toHex, type Hex } from "viem";

import {
    buildSumTree,
    EMPTY_NODE,
    hashLeaf,
    hashNode,
    MAX_SUM,
    proveLeaf,
    sumProofFromJson,
    sumProofToJson,
    verifySumProof,
    type Leaf,
    type SumProof,
} from "./merkle-sum.ts";

/** Deterministic salts, so a failure reproduces. */
const salt = (i: number): Hex => keccak256(toHex(`salt-${i}`));
const leaves = (count: number): Leaf[] =>
    Array.from({ length: count }, (_, i) => ({ salt: salt(i), accountId: BigInt(i + 1), amount: BigInt((i + 1) * 1000) }));

function proofFor(count: number, accountId: bigint) {
    const tree = buildSumTree(leaves(count));
    const proof = proveLeaf(tree, accountId);
    assert.ok(proof);
    return { tree, proof };
}

const invalid = (proof: SumProof, root: { hash: Hex; sum: bigint }) => {
    const result = verifySumProof(proof, root);
    assert.equal(result.valid, false);
    return result.valid ? "" : result.reason;
};

describe("Merkle sum tree", () => {
    it("proves every leaf of every tree size, and its root sums every balance", () => {
        for (let count = 1; count <= 17; count++) {
            const input = leaves(count);
            const tree = buildSumTree(input);
            assert.equal(tree.root.sum, input.reduce((sum, leaf) => sum + leaf.amount, 0n), `size ${count}`);
            for (const leaf of input) {
                const proof = proveLeaf(tree, leaf.accountId);
                assert.ok(proof, `size ${count}, account ${leaf.accountId}`);
                assert.deepEqual(verifySumProof(proof, tree.root), { valid: true, root: tree.root });
            }
        }
    });

    it("has an empty root for no leaves, and no proof for an account it does not hold", () => {
        const tree = buildSumTree([]);
        assert.deepEqual(tree.root, EMPTY_NODE);
        assert.equal(proveLeaf(tree, 1n), undefined);
        assert.equal(proveLeaf(buildSumTree(leaves(3)), 99n), undefined);
    });

    it("orders leaves by their salted hash, not by account", () => {
        const tree = buildSumTree(leaves(8));
        const hashes = tree.leaves.map((leaf) => hashLeaf(leaf).hash);
        assert.deepEqual(hashes, [...hashes].sort());
        assert.notDeepEqual(
            tree.leaves.map((leaf) => leaf.accountId),
            leaves(8).map((leaf) => leaf.accountId),
            "with these salts the order is shuffled",
        );
    });

    it("hashes a leaf and a node differently, so neither can stand in for the other", () => {
        const leaf = { salt: salt(0), accountId: 1n, amount: 5n };
        const asLeaf = hashLeaf(leaf);
        // The same 96 bytes a node would hash, with the node's tag.
        const asNode = hashNode({ hash: leaf.salt, sum: 1n }, { hash: numberToHex(5n, { size: 32 }), sum: 0n });
        assert.notEqual(asLeaf.hash, asNode.hash);
    });

    it("refuses a proof for a different balance, salt or account", () => {
        const { tree, proof } = proofFor(9, 4n);
        invalid({ ...proof, leaf: { ...proof.leaf, amount: proof.leaf.amount + 1n } }, tree.root);
        invalid({ ...proof, leaf: { ...proof.leaf, salt: salt(100) } }, tree.root);
        invalid({ ...proof, leaf: { ...proof.leaf, accountId: 5n } }, tree.root);
    });

    it("refuses a path that has been edited", () => {
        const { tree, proof } = proofFor(9, 4n);
        const edit = (i: number, step: Partial<SumProof["path"][number]>) => ({
            ...proof,
            path: proof.path.map((s, j) => (j === i ? { ...s, ...step } : s)),
        });
        invalid(edit(0, { hash: salt(200) }), tree.root);
        invalid(edit(1, { sum: proof.path[1]!.sum + 1n }), tree.root);
        invalid(edit(0, { side: proof.path[0]!.side === "left" ? "right" : "left" }), tree.root);
        invalid({ ...proof, path: proof.path.slice(1) }, tree.root);
        invalid({ ...proof, path: [...proof.path, { hash: EMPTY_NODE.hash, sum: 0n, side: "right" }] }, tree.root);
    });

    it("catches a platform that understates a branch -- if someone beneath it checks", () => {
        // The platform builds the tree honestly except for one inner node,
        // which it gives a smaller total, rehashing everything above it so the
        // published root is self-consistent -- and smaller.
        const honest = buildSumTree(leaves(8));
        const level1 = honest.levels[1]!;
        const level2 = honest.levels[2]!;
        const shrunk = { ...level1[0]!, sum: level1[0]!.sum - 1000n };
        const forgedRoot = hashNode(hashNode(shrunk, level1[1]!), level2[1]!);
        assert.ok(forgedRoot.sum < honest.root.sum);

        // A user beneath the shrunk node recomputes its true total on the way
        // up, and lands on a root that is not the published one.
        for (const index of [0, 1]) {
            const proof = proveLeaf(honest, honest.leaves[index]!.accountId)!;
            assert.match(invalid(proof, forgedRoot), /different root/);
        }

        // A user elsewhere is handed the shrunk node as a sibling, and their
        // proof checks out. This is the scheme's limit, not a bug: an
        // understatement is caught by the users it shortchanges, so proof of
        // reserves works when enough of them look.
        const elsewhere = proveLeaf(honest, honest.leaves[2]!.accountId)!;
        const served = { ...elsewhere, path: [elsewhere.path[0]!, { ...shrunk, side: "left" as const }, elsewhere.path[2]!] };
        assert.equal(verifySumProof(served, forgedRoot).valid, true);
    });

    it("refuses a published total that differs from what the proof adds up to", () => {
        const { tree, proof } = proofFor(5, 2n);
        assert.match(invalid(proof, { ...tree.root, sum: tree.root.sum - 1n }), /published total/);
        assert.match(invalid(proof, { hash: EMPTY_NODE.hash, sum: tree.root.sum }), /different root/);
    });

    it("refuses negative and oversized sums", () => {
        const { tree, proof } = proofFor(4, 1n);
        const withSum = (sum: bigint) => ({ ...proof, path: [{ ...proof.path[0]!, sum }, ...proof.path.slice(1)] });
        assert.match(invalid(withSum(-1n), tree.root), /uint256/);
        assert.match(invalid(withSum(MAX_SUM), tree.root), /uint256/);
        assert.throws(() => hashLeaf({ salt: salt(0), accountId: 1n, amount: -1n }), RangeError);
        assert.throws(() => buildSumTree([{ salt: salt(0), accountId: 1n, amount: MAX_SUM }, ...leaves(1)]), RangeError);
    });

    it("refuses hashes and salts that are not exactly 32 bytes", () => {
        const { tree, proof } = proofFor(4, 1n);
        assert.match(invalid({ ...proof, path: [{ ...proof.path[0]!, hash: "0x1234" }, ...proof.path.slice(1)] }, tree.root), /32 bytes/);
        assert.throws(() => hashLeaf({ salt: "0x00", accountId: 1n, amount: 1n }), /32 bytes/);
    });

    it("round-trips through JSON, and parses untrusted JSON strictly", () => {
        const { tree, proof } = proofFor(6, 3n);
        const json = JSON.parse(JSON.stringify(sumProofToJson(proof)));
        assert.deepEqual(sumProofFromJson(json), proof);
        assert.equal(verifySumProof(sumProofFromJson(json), tree.root).valid, true);

        const bad = [
            null,
            { leaf: json.leaf },
            { ...json, leaf: { ...json.leaf, amount: 5 } },
            { ...json, leaf: { ...json.leaf, amount: "-5" } },
            { ...json, leaf: { ...json.leaf, amount: "0x10" } },
            { ...json, leaf: { ...json.leaf, salt: "0x12" } },
            { ...json, path: [{ ...json.path[0], side: "up" }] },
            { ...json, path: [{ ...json.path[0], hash: "0xabc" }] },
            { ...json, path: [{ ...json.path[0], sum: "1.5" }] },
        ];
        for (const input of bad) assert.throws(() => sumProofFromJson(input), RangeError, JSON.stringify(input));
    });
});
