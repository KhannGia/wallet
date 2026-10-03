// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {MultisigVault} from "../../src/vault/MultisigVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MultisigVaultBase} from "./MultisigVaultBase.sol";

/// @dev Re-enters executeQueued with the very call being executed.
contract QueueReenterer {
    MultisigVault private immutable vault;
    uint256 private queuedNonce;
    bool public reentryBlocked;

    constructor(MultisigVault vault_) {
        vault = vault_;
    }

    function arm(uint256 queuedNonce_) external {
        queuedNonce = queuedNonce_;
    }

    receive() external payable {
        try vault.executeQueued(address(this), msg.value, "", queuedNonce) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
    }
}

/// @dev The timelock and the fast path, on a vault with a one-day delay and a
///      daily allowance of 2 ether and 100 USDC towards the hot wallet.
contract MultisigVaultTimelockTest is MultisigVaultBase {
    address internal constant HOT = address(0x407);
    address internal constant THIEF = address(0xBAD);

    uint256 internal constant DELAY = 1 days;
    uint256 internal constant ETHER_LIMIT = 2 ether;
    uint256 internal constant TOKEN_LIMIT = 100_000_000;

    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        vault = new MultisigVault(owners, THRESHOLD, _timelocked(DELAY));
        vm.deal(address(vault), 10 ether);
        token.mint(address(vault), 1_000_000_000);
        deadline = block.timestamp + 1 hours;
    }

    function _timelocked(uint256 delay) internal view returns (MultisigVault.Config memory config) {
        config.delay = delay;
        config.hotWallet = HOT;
        config.assets = new address[](2);
        config.limits = new uint256[](2);
        (config.assets[0], config.limits[0]) = (address(0), ETHER_LIMIT);
        (config.assets[1], config.limits[1]) = (address(token), TOKEN_LIMIT);
    }

    function _execute(address to, uint256 value, bytes memory data)
        internal
        returns (bytes memory)
    {
        return vault.execute(to, value, data, deadline, _approve(to, value, data, deadline));
    }

    function _queue(address to, uint256 value, bytes memory data) internal returns (uint256) {
        return vault.queue(to, value, data, deadline, _approve(to, value, data, deadline));
    }

    function _tokenTransfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(MockERC20.transfer, (to, amount));
    }

    // --- construction ---------------------------------------------------------

    function test_StoresConfiguration() public view {
        assertEq(vault.delay(), DELAY);
        assertEq(vault.hotWallet(), HOT);
        (uint256 etherLimit,,) = vault.allowances(address(0));
        (uint256 tokenLimit,,) = vault.allowances(address(token));
        assertEq(etherLimit, ETHER_LIMIT);
        assertEq(tokenLimit, TOKEN_LIMIT);
    }

    function test_RevertWhen_DelayIsTooLong() public {
        uint256 tooLong = vault.MAX_DELAY() + 1;
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.DelayTooLong.selector, tooLong));
        new MultisigVault(owners, THRESHOLD, _timelocked(tooLong));
    }

    function test_RevertWhen_LimitsDoNotMatchAssets() public {
        MultisigVault.Config memory config = _timelocked(DELAY);
        config.limits = new uint256[](1);
        vm.expectRevert(MultisigVault.LengthMismatch.selector);
        new MultisigVault(owners, THRESHOLD, config);
    }

    // --- fast path ------------------------------------------------------------

    function test_TopsUpTheHotWalletWithEtherAtOnce() public {
        _execute(HOT, 1 ether, "");

        assertEq(HOT.balance, 1 ether);
        assertEq(vault.remainingToday(address(0)), ETHER_LIMIT - 1 ether);
    }

    function test_TopsUpTheHotWalletWithTokensAtOnce() public {
        _execute(address(token), 0, _tokenTransfer(HOT, 60_000_000));

        assertEq(token.balanceOf(HOT), 60_000_000);
        assertEq(vault.remainingToday(address(token)), TOKEN_LIMIT - 60_000_000);
        // Allowances are per asset: moving tokens leaves the ether allowance whole.
        assertEq(vault.remainingToday(address(0)), ETHER_LIMIT);
    }

    function test_RevertWhen_TopUpExceedsTodaysAllowance() public {
        _execute(HOT, 1.5 ether, "");

        bytes[] memory sigs = _approve(HOT, 1 ether, "", deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(HOT, 1 ether, "", deadline, sigs);

        assertEq(HOT.balance, 1.5 ether);
        assertEq(vault.nonce(), 1, "a refused call spends no nonce");
    }

    function test_AllowanceRestartsAfterADay() public {
        _execute(HOT, ETHER_LIMIT, "");
        assertEq(vault.remainingToday(address(0)), 0);

        vm.warp(block.timestamp + 1 days);
        deadline = block.timestamp + 1 hours;

        assertEq(vault.remainingToday(address(0)), ETHER_LIMIT);
        _execute(HOT, ETHER_LIMIT, "");
        assertEq(HOT.balance, 2 * ETHER_LIMIT);
    }

    function test_RevertWhen_PayingAnyoneElseWithoutTheQueue() public {
        bytes[] memory sigs = _approve(RECIPIENT, 1 wei, "", deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(RECIPIENT, 1 wei, "", deadline, sigs);
    }

    function test_RevertWhen_TokenHasNoAllowance() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(vault), 1 ether);

        bytes memory data = _tokenTransfer(HOT, 1);
        bytes[] memory sigs = _approve(address(other), 0, data, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(other), 0, data, deadline, sigs);
    }

    function test_NoFastPathWithoutAHotWallet() public {
        MultisigVault.Config memory config = _timelocked(DELAY);
        config.hotWallet = address(0);
        vault = new MultisigVault(owners, THRESHOLD, config);
        vm.deal(address(vault), 1 ether);

        // Ether "to the hot wallet" would be ether to the zero address.
        bytes[] memory sigs = _approve(address(0), 1 wei, "", deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(0), 1 wei, "", deadline, sigs);
    }

    function test_TimelockOffStillCountsTopUps() public {
        vault = new MultisigVault(owners, THRESHOLD, _timelocked(0));
        vm.deal(address(vault), 10 ether);

        _execute(RECIPIENT, 1 ether, "");
        _execute(HOT, 1 ether, "");

        // Switching the timelock back on must not inherit a day of transfers
        // nobody recorded.
        assertEq(vault.remainingToday(address(0)), ETHER_LIMIT - 1 ether);
    }

    // --- queue ----------------------------------------------------------------

    function test_ExecutesAQueuedCallAfterTheDelay() public {
        vm.expectEmit(address(vault));
        emit MultisigVault.Queued(0, RECIPIENT, 5 ether, "", block.timestamp + DELAY);
        uint256 queuedNonce = _queue(RECIPIENT, 5 ether, "");

        assertEq(queuedNonce, 0);
        assertEq(vault.nonce(), 1, "the nonce is spent when the call is queued");
        assertEq(vault.queued(vault.queueId(0, RECIPIENT, 5 ether, "")), block.timestamp + DELAY);
        assertEq(RECIPIENT.balance, 0);

        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(address(vault));
        emit MultisigVault.Executed(0, RECIPIENT, 5 ether, "", "");
        vault.executeQueued(RECIPIENT, 5 ether, "", queuedNonce);

        assertEq(RECIPIENT.balance, 5 ether);
    }

    function test_RevertWhen_ExecutedBeforeTheDelay() public {
        uint256 queuedNonce = _queue(RECIPIENT, 5 ether, "");
        uint256 eta = block.timestamp + DELAY;

        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotReady.selector, eta, eta - 1));
        vault.executeQueued(RECIPIENT, 5 ether, "", queuedNonce);
    }

    function test_RevertWhen_ExecutedAfterTheGracePeriod() public {
        uint256 queuedNonce = _queue(RECIPIENT, 5 ether, "");
        uint256 eta = block.timestamp + DELAY;
        uint256 late = eta + vault.GRACE_PERIOD() + 1;

        vm.warp(late);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.QueueExpired.selector, eta, late));
        vault.executeQueued(RECIPIENT, 5 ether, "", queuedNonce);
    }

    function test_RevertWhen_ExecutingADifferentCallThanQueued() public {
        uint256 queuedNonce = _queue(RECIPIENT, 5 ether, "");
        vm.warp(block.timestamp + DELAY);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotQueued.selector, queuedNonce));
        vault.executeQueued(THIEF, 5 ether, "", queuedNonce);
    }

    function test_RevertWhen_ExecutedTwice() public {
        uint256 queuedNonce = _queue(RECIPIENT, 1 ether, "");
        vm.warp(block.timestamp + DELAY);
        vault.executeQueued(RECIPIENT, 1 ether, "", queuedNonce);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotQueued.selector, queuedNonce));
        vault.executeQueued(RECIPIENT, 1 ether, "", queuedNonce);
    }

    function test_QueuedCallDoesNotHoldUpLaterApprovals() public {
        _queue(RECIPIENT, 5 ether, "");

        // Nonce 1 is free at once; a top-up does not wait behind a large payout.
        _execute(HOT, 1 ether, "");
        assertEq(HOT.balance, 1 ether);
        assertEq(vault.nonce(), 2);
    }

    function test_FailedQueuedCallCanBeRetried() public {
        uint256 queuedNonce = _queue(RECIPIENT, 50 ether, "");
        vm.warp(block.timestamp + DELAY);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.CallFailed.selector, ""));
        vault.executeQueued(RECIPIENT, 50 ether, "", queuedNonce);

        vm.deal(address(vault), 50 ether);
        vault.executeQueued(RECIPIENT, 50 ether, "", queuedNonce);
        assertEq(RECIPIENT.balance, 50 ether);
    }

    function test_ZeroDelayQueueExecutesInTheSameBlock() public {
        vault = new MultisigVault(owners, THRESHOLD, _timelocked(0));
        vm.deal(address(vault), 1 ether);

        uint256 queuedNonce = _queue(RECIPIENT, 1 ether, "");
        vault.executeQueued(RECIPIENT, 1 ether, "", queuedNonce);
        assertEq(RECIPIENT.balance, 1 ether);
    }

    // --- cancel ---------------------------------------------------------------

    function test_AnySingleOwnerCanCancel() public {
        uint256 queuedNonce = _queue(RECIPIENT, 5 ether, "");

        vm.expectEmit(address(vault));
        emit MultisigVault.Cancelled(queuedNonce, owners[4]);
        vm.prank(owners[4]);
        vault.cancel(RECIPIENT, 5 ether, "", queuedNonce);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotQueued.selector, queuedNonce));
        vault.executeQueued(RECIPIENT, 5 ether, "", queuedNonce);
    }

    function test_RevertWhen_OutsiderCancels() public {
        uint256 queuedNonce = _queue(RECIPIENT, 5 ether, "");

        vm.prank(THIEF);
        vm.expectRevert(MultisigVault.OnlyOwner.selector);
        vault.cancel(RECIPIENT, 5 ether, "", queuedNonce);
    }

    function test_RevertWhen_CancellingWhatIsNotQueued() public {
        vm.prank(owners[0]);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotQueued.selector, 7));
        vault.cancel(RECIPIENT, 5 ether, "", 7);
    }

    // --- configuration --------------------------------------------------------

    function test_RevertWhen_ConfigurationIsChangedDirectly() public {
        vm.prank(owners[0]);
        vm.expectRevert(MultisigVault.OnlyVault.selector);
        vault.setDailyLimit(address(0), 100 ether);

        vm.expectRevert(MultisigVault.OnlyVault.selector);
        vault.setHotWallet(THIEF);

        vm.expectRevert(MultisigVault.OnlyVault.selector);
        vault.setDelay(0);
    }

    function test_ChangesConfigurationThroughTheQueue() public {
        bytes memory raise = abi.encodeCall(MultisigVault.setDailyLimit, (address(0), 5 ether));
        bytes memory move = abi.encodeCall(MultisigVault.setHotWallet, (RECIPIENT));
        bytes memory shorten = abi.encodeCall(MultisigVault.setDelay, (1 hours));

        uint256 first = _queue(address(vault), 0, raise);
        uint256 second = _queue(address(vault), 0, move);
        uint256 third = _queue(address(vault), 0, shorten);

        vm.warp(block.timestamp + DELAY);
        vault.executeQueued(address(vault), 0, raise, first);
        vault.executeQueued(address(vault), 0, move, second);
        vault.executeQueued(address(vault), 0, shorten, third);

        (uint256 limit,,) = vault.allowances(address(0));
        assertEq(limit, 5 ether);
        assertEq(vault.hotWallet(), RECIPIENT);
        assertEq(vault.delay(), 1 hours);
    }

    function test_RevertWhen_ConfiguredDelayIsTooLong() public {
        bytes memory forever = abi.encodeCall(MultisigVault.setDelay, (365 days));
        uint256 queuedNonce = _queue(address(vault), 0, forever);
        vm.warp(block.timestamp + DELAY);

        // The vault's own revert surfaces inside CallFailed.
        vm.expectRevert(
            abi.encodeWithSelector(
                MultisigVault.CallFailed.selector,
                abi.encodeWithSelector(MultisigVault.DelayTooLong.selector, 365 days)
            )
        );
        vault.executeQueued(address(vault), 0, forever, queuedNonce);
    }

    // --- attacks --------------------------------------------------------------

    /// The scenario the timelock exists for. A thief holding a quorum of keys
    /// queues a drain; one honest owner sees it and cancels before it matures.
    function test_Attack_ThiefWithAQuorumIsStoppedByOneOwner() public {
        uint256 queuedNonce = _queue(THIEF, 10 ether, "");

        vm.prank(owners[3]);
        vault.cancel(THIEF, 10 ether, "", queuedNonce);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        vault.executeQueued(THIEF, 10 ether, "", queuedNonce);
        assertEq(THIEF.balance, 0);
    }

    /// A per-call cap only changes how many transactions a thief needs. Even
    /// splitting the drain into tiny top-ups, a day yields one allowance.
    function test_Attack_SplittingADrainIntoSmallTopUps() public {
        uint256 step = 0.1 ether;
        uint256 moved;
        for (uint256 i; i < 50; ++i) {
            bytes[] memory sigs = _approve(HOT, step, "", deadline);
            try vault.execute(HOT, step, "", deadline, sigs) {
                moved += step;
            } catch {
                break;
            }
        }

        assertEq(moved, ETHER_LIMIT);
        assertEq(HOT.balance, ETHER_LIMIT);
    }

    /// approve() would let the thief pull the tokens later with transferFrom,
    /// outside any allowance. Only transfer() to the hot wallet is fast.
    function test_Attack_ApproveToSidestepTheFastPath() public {
        bytes memory data = abi.encodeCall(MockERC20.approve, (THIEF, type(uint256).max));
        bytes[] memory sigs = _approve(address(token), 0, data, deadline);

        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(token), 0, data, deadline, sigs);
    }

    /// A transfer within the allowance, but to the thief rather than the hot wallet.
    function test_Attack_TokenTopUpToTheWrongRecipient() public {
        bytes memory data = _tokenTransfer(THIEF, 1);
        bytes[] memory sigs = _approve(address(token), 0, data, deadline);

        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(token), 0, data, deadline, sigs);
    }

    /// Trailing bytes or attached ether make a call that is not exactly the
    /// recognised shape, and a lax parser would wave either through.
    function test_Attack_MalformedTopUps() public {
        bytes memory padded = bytes.concat(_tokenTransfer(HOT, 1), bytes32(0));
        bytes[] memory sigs = _approve(address(token), 0, padded, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(token), 0, padded, deadline, sigs);

        bytes memory exact = _tokenTransfer(HOT, 1);
        sigs = _approve(address(token), 1 ether, exact, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(token), 1 ether, exact, deadline, sigs);
    }

    /// Raise the allowance, or point the hot wallet at the thief, then use the
    /// fast path at once. Both are calls to the vault, which are never fast.
    function test_Attack_ReconfigureThenDrain() public {
        bytes memory raise =
            abi.encodeCall(MultisigVault.setDailyLimit, (address(0), type(uint256).max));
        bytes[] memory sigs = _approve(address(vault), 0, raise, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(vault), 0, raise, deadline, sigs);

        bytes memory redirect = abi.encodeCall(MultisigVault.setHotWallet, (THIEF));
        sigs = _approve(address(vault), 0, redirect, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(vault), 0, redirect, deadline, sigs);

        bytes memory disable = abi.encodeCall(MultisigVault.setDelay, (0));
        sigs = _approve(address(vault), 0, disable, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(vault), 0, disable, deadline, sigs);
    }

    /// Ether has an allowance under the key address(0). A "token transfer"
    /// sent to address(0) succeeds against no code; it must not be read as a
    /// fast-path ether top-up, nor pass as anything but a queued call.
    function test_Attack_ZeroAddressPosingAsAToken() public {
        bytes memory data = _tokenTransfer(HOT, 1 ether);
        bytes[] memory sigs = _approve(address(0), 0, data, deadline);

        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(0), 0, data, deadline, sigs);
        assertEq(vault.remainingToday(address(0)), ETHER_LIMIT);
    }

    /// A vault misconfigured with an allowance for itself still never treats a
    /// call to itself as a top-up.
    function test_Attack_VaultGivenAnAllowanceForItself() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        MultisigVault.Config memory config = _timelocked(DELAY);
        config.assets[1] = predicted;
        vault = new MultisigVault(owners, THRESHOLD, config);
        assertEq(address(vault), predicted);

        bytes memory data = _tokenTransfer(HOT, 1);
        bytes[] memory sigs = _approve(address(vault), 0, data, deadline);
        vm.expectRevert(MultisigVault.TimelockRequired.selector);
        vault.execute(address(vault), 0, data, deadline, sigs);
    }

    /// The recipient of a queued payout re-enters executeQueued with the same
    /// call before the first has returned.
    function test_Attack_ReentrancyThroughExecuteQueued() public {
        QueueReenterer reenterer = new QueueReenterer(vault);
        uint256 queuedNonce = _queue(address(reenterer), 1 ether, "");
        reenterer.arm(queuedNonce);
        vm.warp(block.timestamp + DELAY);

        vault.executeQueued(address(reenterer), 1 ether, "", queuedNonce);

        assertTrue(reenterer.reentryBlocked(), "the nested call must have been refused");
        assertEq(address(reenterer).balance, 1 ether, "paid exactly once");
    }
}
