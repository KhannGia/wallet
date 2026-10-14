// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @title An append-only record of proof-of-reserves attestations.
/// @notice Each attestation is the root of a Merkle sum tree over what every
///         user is owed, that root's total, the assets the platform held, and
///         the block both were read at. A user checks their own proof against
///         a root read from here, not from the platform's API.
/// @dev Published on chain because a root served only by the platform could be
///      a different root for every user who asks: each would see their own
///      balance included in a tree built just for them, and none would see the
///      tree that understates everyone else. Here there is one sequence of
///      roots, the same for everybody, and nothing in it can be changed or
///      removed once written.
///
///      The contract cannot check the numbers: the liabilities are off chain,
///      and the assets were read at a past block. It holds the platform to what
///      it said, in order, for everyone to compare against.
contract ReservesRegistry {
    struct Attestation {
        /// @notice Root hash of the Merkle sum tree over every user's liability.
        bytes32 root;
        /// @notice The root's sum: the total owed to users.
        uint256 liabilities;
        /// @notice Token balances of every address the platform controls.
        uint256 assets;
        /// @notice The block both sides were read at.
        uint64 blockNumber;
        uint64 publishedAt;
    }

    /// @notice The only account that may publish. One key, so a stolen API
    ///         server cannot write a root; it holds no key at all.
    address public immutable publisher;

    /// @notice The token every amount is denominated in.
    address public immutable token;

    Attestation[] private _attestations;

    /// @dev Root to its latest id, plus one so that zero means "never".
    mapping(bytes32 root => uint256 idPlusOne) private _latestByRoot;

    event Published(
        uint256 indexed id,
        bytes32 indexed root,
        uint256 liabilities,
        uint256 assets,
        uint64 blockNumber
    );

    error ZeroAddress();
    error NotPublisher(address caller);
    error EmptyRoot();
    error NotInThePast(uint64 blockNumber, uint256 currentBlock);
    error BeforePrevious(uint64 blockNumber, uint64 previous);
    error UnknownAttestation(uint256 id);
    error UnknownRoot(bytes32 root);

    constructor(address publisher_, address token_) {
        if (publisher_ == address(0) || token_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        token = token_;
    }

    /// @notice Records an attestation.
    /// @dev The block must already exist -- balances cannot have been read at
    ///      one that does not -- and may not go back before the last one, so
    ///      the record reads forwards in time. It may repeat the last one:
    ///      balances between users change with no new block on the chain.
    function publish(bytes32 root, uint256 liabilities, uint256 assets, uint64 blockNumber)
        external
        returns (uint256 id)
    {
        if (msg.sender != publisher) revert NotPublisher(msg.sender);
        if (root == bytes32(0)) revert EmptyRoot();
        if (blockNumber >= block.number) revert NotInThePast(blockNumber, block.number);

        id = _attestations.length;
        if (id > 0) {
            uint64 previous = _attestations[id - 1].blockNumber;
            if (blockNumber < previous) revert BeforePrevious(blockNumber, previous);
        }

        _attestations.push(
            Attestation({
                root: root,
                liabilities: liabilities,
                assets: assets,
                blockNumber: blockNumber,
                publishedAt: uint64(block.timestamp)
            })
        );
        _latestByRoot[root] = id + 1;
        emit Published(id, root, liabilities, assets, blockNumber);
    }

    function count() external view returns (uint256) {
        return _attestations.length;
    }

    function attestation(uint256 id) external view returns (Attestation memory) {
        if (id >= _attestations.length) revert UnknownAttestation(id);
        return _attestations[id];
    }

    /// @notice The most recent attestation.
    function latest() external view returns (uint256 id, Attestation memory) {
        uint256 total = _attestations.length;
        if (total == 0) revert UnknownAttestation(0);
        id = total - 1;
        return (id, _attestations[id]);
    }

    /// @notice The latest attestation of `root` -- what a user holding a proof
    ///         for that root looks up. Only an empty tree's root can repeat.
    function findByRoot(bytes32 root) external view returns (uint256 id, Attestation memory) {
        uint256 idPlusOne = _latestByRoot[root];
        if (idPlusOne == 0) revert UnknownRoot(root);
        id = idPlusOne - 1;
        return (id, _attestations[id]);
    }
}
