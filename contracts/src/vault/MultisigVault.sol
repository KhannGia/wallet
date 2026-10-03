// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title M-of-N vault for the platform's reserves.
/// @notice Holds the funds the platform keeps on behalf of users, and moves them
///         only when `threshold` distinct owners have signed the exact call.
///         No single owner -- the operator included -- can drain it alone.
/// @dev What is written here is the multisig logic itself. The primitives that
///      are dangerous to hand-roll are OpenZeppelin's: ECDSA recovery (which
///      rejects malleable signatures), the EIP-712 domain, and the reentrancy
///      guard.
///
///      A quorum alone is not enough for most calls. Whoever steals `threshold`
///      keys could otherwise empty the vault in one transaction, so anything
///      but a small top-up of the hot wallet is queued for `delay` seconds,
///      during which any single owner can cancel it. Small top-ups -- the
///      routine operation -- go straight through, within a daily allowance per
///      asset. A delay of zero switches the timelock off entirely.
contract MultisigVault is EIP712, ReentrancyGuard {
    /// @dev Every field that decides what the call does is signed. Leaving any
    ///      of them out would let whoever submits the transaction change it
    ///      after the owners approved it.
    bytes32 public constant EXECUTE_TYPEHASH =
        keccak256("Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)");

    /// @notice How long a queued call stays executable once its delay has passed.
    ///         An approval nobody acted on for two weeks should not stay live.
    uint256 public constant GRACE_PERIOD = 14 days;

    /// @notice The longest delay the vault accepts, so a misconfiguration
    ///         cannot lock the reserves away for good.
    uint256 public constant MAX_DELAY = 30 days;

    /// @dev The asset key for the native currency in `allowances`.
    address public constant NATIVE = address(0);

    uint256 public immutable threshold;

    /// @notice Seconds a queued call must wait. Zero disables the timelock.
    uint256 public delay;

    /// @notice The only destination the fast path will send to.
    address public hotWallet;

    /// @dev `spent` counts fast-path transfers since `windowStart`; a window
    ///      lasts one day and restarts on the first transfer after it ends.
    struct Allowance {
        uint256 limit;
        uint256 spent;
        uint256 windowStart;
    }

    /// @notice Fast-path allowance per asset: NATIVE for ether, else the token.
    mapping(address asset => Allowance) public allowances;

    /// @notice When each queued call becomes executable, keyed by `queueId`.
    ///         Zero means not queued.
    mapping(bytes32 id => uint256 eta) public queued;

    /// @notice Incremented by every successful execution. Signatures cover the
    ///         nonce, so each approval can be spent exactly once.
    uint256 public nonce;

    mapping(address => bool) public isOwner;
    address[] private _owners;

    event Executed(
        uint256 indexed nonce, address indexed to, uint256 value, bytes data, bytes result
    );
    event Deposited(address indexed from, uint256 value);
    event Queued(uint256 indexed nonce, address indexed to, uint256 value, bytes data, uint256 eta);
    event Cancelled(uint256 indexed nonce, address indexed by);
    event DelayChanged(uint256 delay);
    event HotWalletChanged(address hotWallet);
    event DailyLimitChanged(address indexed asset, uint256 limit);

    error InvalidThreshold(uint256 threshold, uint256 ownerCount);
    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error Expired(uint256 deadline, uint256 timestamp);
    error SignatureCountMismatch(uint256 provided, uint256 required);
    error SignersNotAscending(address previous, address current);
    error NotAnOwner(address signer);
    error CallFailed(bytes returndata);
    error TimelockRequired();
    error NotQueued(uint256 nonce);
    error NotReady(uint256 eta, uint256 timestamp);
    error QueueExpired(uint256 eta, uint256 timestamp);
    error OnlyVault();
    error OnlyOwner();
    error DelayTooLong(uint256 delay);
    error LengthMismatch();

    /// @param assets Assets the fast path may move: NATIVE for ether, or a token.
    /// @param limits Each asset's daily fast-path allowance, in its own units.
    struct Config {
        uint256 delay;
        address hotWallet;
        address[] assets;
        uint256[] limits;
    }

    /// @dev Configuration changes are calls the vault makes to itself, which
    ///      can only happen through `execute` or `executeQueued` -- and a call
    ///      to the vault is never fast-path, so every change waits out the
    ///      current delay where any owner can see and cancel it.
    modifier onlyVault() {
        if (msg.sender != address(this)) revert OnlyVault();
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_, Config memory config)
        EIP712("MultisigVault", "1")
    {
        if (threshold_ == 0 || threshold_ > owners_.length) {
            revert InvalidThreshold(threshold_, owners_.length);
        }

        for (uint256 i; i < owners_.length; ++i) {
            address owner = owners_[i];
            if (owner == address(0) || owner == address(this)) revert InvalidOwner(owner);
            if (isOwner[owner]) revert DuplicateOwner(owner);
            isOwner[owner] = true;
        }

        _owners = owners_;
        threshold = threshold_;

        if (config.assets.length != config.limits.length) revert LengthMismatch();
        _setDelay(config.delay);
        _setHotWallet(config.hotWallet);
        for (uint256 i; i < config.assets.length; ++i) {
            _setDailyLimit(config.assets[i], config.limits[i]);
        }
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    /// @notice The digest owners sign for a given call. Exposed so off-chain
    ///         signers compute exactly what the contract will verify.
    /// @dev The EIP-712 domain binds the chain id and this contract's address,
    ///      so a signature collected for one vault or one chain is worthless on
    ///      any other.
    function hashExecute(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 nonce_,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), nonce_, deadline))
        );
    }

    /// @notice Performs `to.call{value}(data)` at once, if it needs no delay:
    ///         either the timelock is off, or the call is a hot-wallet top-up
    ///         within today's allowance. Anything else must go through `queue`.
    /// @param signatures Exactly `threshold` signatures, ordered by signer
    ///        address, strictly ascending.
    /// @dev Strictly ascending order is what makes the signers distinct: without
    ///      it, one owner's signature repeated `threshold` times would pass.
    ///
    ///      A reverted call reverts everything, the nonce increment and the
    ///      allowance included, so the same approval can be retried -- once the
    ///      vault is funded, say -- until its deadline passes.
    ///
    ///      This is a generic call and the vault cannot know what success means
    ///      to the target. An ERC-20 that signals failure by returning false
    ///      rather than reverting will look like a success here; whoever proposes
    ///      a transfer must check the return data, exactly as the payout worker
    ///      checks for a Transfer event.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes[] calldata signatures
    ) external nonReentrant returns (bytes memory result) {
        uint256 currentNonce = _consumeApproval(to, value, data, deadline, signatures);

        // The allowance is spent even with the timelock off, so turning it back
        // on does not inherit a day's worth of unrecorded transfers.
        bool topUp = _spendAllowance(to, value, data);
        if (!topUp && delay != 0) revert TimelockRequired();

        result = _call(currentNonce, to, value, data);
    }

    /// @notice Spends an approval now and schedules its call for `delay` seconds
    ///         from now. Any owner can cancel it until it executes.
    /// @dev The nonce is consumed here, not on execution, so a call waiting out
    ///      its delay does not hold up the approvals queued behind it.
    function queue(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes[] calldata signatures
    ) external nonReentrant returns (uint256 queuedNonce) {
        queuedNonce = _consumeApproval(to, value, data, deadline, signatures);

        uint256 eta = block.timestamp + delay;
        queued[queueId(queuedNonce, to, value, data)] = eta;
        emit Queued(queuedNonce, to, value, data, eta);
    }

    /// @notice Performs a queued call once its delay has passed. Anyone may
    ///         call it: the owners approved the call when it was queued, and
    ///         the parameters must match what they approved exactly.
    function executeQueued(address to, uint256 value, bytes calldata data, uint256 queuedNonce)
        external
        nonReentrant
        returns (bytes memory result)
    {
        bytes32 id = queueId(queuedNonce, to, value, data);
        uint256 eta = queued[id];
        if (eta == 0) revert NotQueued(queuedNonce);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < eta) revert NotReady(eta, block.timestamp);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > eta + GRACE_PERIOD) revert QueueExpired(eta, block.timestamp);

        // Cleared before the call, so a reentrant call finds nothing to run. A
        // revert below restores it, and the call can be retried within grace.
        delete queued[id];
        result = _call(queuedNonce, to, value, data);
    }

    /// @notice Cancels a queued call. One owner is enough: if a thief holds a
    ///         quorum of keys, the honest owners left are by definition fewer
    ///         than a quorum, and a cancel that needed one would never come.
    ///         The cost is that a single rogue owner can delay any call -- but
    ///         delay is all they can do, never move funds.
    function cancel(address to, uint256 value, bytes calldata data, uint256 queuedNonce) external {
        if (!isOwner[msg.sender]) revert OnlyOwner();
        bytes32 id = queueId(queuedNonce, to, value, data);
        if (queued[id] == 0) revert NotQueued(queuedNonce);

        delete queued[id];
        emit Cancelled(queuedNonce, msg.sender);
    }

    /// @notice Identifies a queued call. The nonce alone is unique, but binding
    ///         the call too means a caller must present exactly what was
    ///         approved in order to run or cancel it.
    function queueId(uint256 queuedNonce, address to, uint256 value, bytes calldata data)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(queuedNonce, to, value, keccak256(data)));
    }

    /// @notice What the fast path may still move today for `asset`.
    function remainingToday(address asset) public view returns (uint256) {
        Allowance storage allowance = allowances[asset];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= allowance.windowStart + 1 days) return allowance.limit;
        return allowance.spent >= allowance.limit ? 0 : allowance.limit - allowance.spent;
    }

    // --- configuration: only through the vault's own approval process ---------

    function setDelay(uint256 delay_) external onlyVault {
        _setDelay(delay_);
    }

    function setHotWallet(address hotWallet_) external onlyVault {
        _setHotWallet(hotWallet_);
    }

    function setDailyLimit(address asset, uint256 limit) external onlyVault {
        _setDailyLimit(asset, limit);
    }

    // --- internals ------------------------------------------------------------

    /// @dev Checks a quorum for this call at the current nonce and spends the
    ///      nonce. Everything that makes an approval valid lives here, shared by
    ///      `execute` and `queue`, so the two paths cannot drift apart.
    function _consumeApproval(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes[] calldata signatures
    ) private returns (uint256 currentNonce) {
        // A proposer can shift this by a few seconds at most, and a multisig
        // deadline is measured in hours. The skew cannot turn an expired
        // approval into a live one in any way that matters.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) {
            revert Expired(deadline, block.timestamp);
        }
        if (signatures.length != threshold) {
            revert SignatureCountMismatch(signatures.length, threshold);
        }

        currentNonce = nonce;
        bytes32 digest = hashExecute(to, value, data, currentNonce, deadline);

        address previous = address(0);
        for (uint256 i; i < signatures.length; ++i) {
            // ECDSA.recover reverts on a malformed or malleable signature rather
            // than returning the zero address or a second valid signer.
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= previous) revert SignersNotAscending(previous, signer);
            if (!isOwner[signer]) revert NotAnOwner(signer);
            previous = signer;
        }

        // Effects before interactions: the approval is spent before control
        // leaves the contract, so a reentrant call cannot reuse it even if the
        // guard were ever removed.
        nonce = currentNonce + 1;
    }

    function _call(uint256 callNonce, address to, uint256 value, bytes calldata data)
        private
        returns (bytes memory result)
    {
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert CallFailed(result);

        emit Executed(callNonce, to, value, data, result);
    }

    /// @dev Whether the call is a hot-wallet top-up within today's allowance,
    ///      and if so, records it against the allowance.
    ///
    ///      Exactly two shapes qualify: plain ether to the hot wallet, and a
    ///      token's own `transfer(hotWallet, amount)` with no ether attached.
    ///      Anything else -- `approve`, `transferFrom`, a call to the vault
    ///      itself, a transfer to any other address -- waits. Recognising more
    ///      shapes would be recognising more ways around the timelock.
    ///
    ///      The allowance is daily rather than per call because a per-call cap
    ///      only changes how many transactions a thief needs.
    function _spendAllowance(address to, uint256 value, bytes calldata data)
        private
        returns (bool)
    {
        address destination = hotWallet;
        if (destination == address(0)) return false;

        address asset;
        uint256 amount;
        if (to == destination && data.length == 0) {
            (asset, amount) = (NATIVE, value);
        } else if (
            // NATIVE is not a token: a "transfer" sent to the zero address
            // would succeed against no code and be booked as ether. Nor is the
            // vault, whatever limit it were given.
            to != NATIVE && to != address(this) && value == 0 && data.length == 68
                && bytes4(data[:4]) == IERC20.transfer.selector && allowances[to].limit != 0
        ) {
            (address recipient, uint256 tokens) = abi.decode(data[4:], (address, uint256));
            if (recipient != destination) return false;
            (asset, amount) = (to, tokens);
        } else {
            return false;
        }

        if (amount > remainingToday(asset)) return false;

        Allowance storage allowance = allowances[asset];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= allowance.windowStart + 1 days) {
            allowance.windowStart = block.timestamp;
            allowance.spent = 0;
        }
        allowance.spent += amount;
        return true;
    }

    function _setDelay(uint256 delay_) private {
        if (delay_ > MAX_DELAY) revert DelayTooLong(delay_);
        delay = delay_;
        emit DelayChanged(delay_);
    }

    function _setHotWallet(address hotWallet_) private {
        hotWallet = hotWallet_;
        emit HotWalletChanged(hotWallet_);
    }

    function _setDailyLimit(address asset, uint256 limit) private {
        allowances[asset].limit = limit;
        emit DailyLimitChanged(asset, limit);
    }
}
