// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MultisigVault} from "../../src/vault/MultisigVault.sol";
import {MultisigVaultBase} from "./MultisigVaultBase.sol";

/// @dev Receives a payout from the vault and, while the call is still in
///      progress, tries to spend the very same approval a second time.
contract Reenterer {
    MultisigVault internal immutable vault;
    uint256 internal deadline;
    bytes[] internal signatures;
    uint256 internal calls;
    bool public reentryBlocked;

    constructor(MultisigVault vault_) {
        vault = vault_;
    }

    function arm(uint256 deadline_, bytes[] memory signatures_) external {
        deadline = deadline_;
        for (uint256 i; i < signatures_.length; ++i) {
            signatures.push(signatures_[i]);
        }
    }

    receive() external payable {
        if (calls++ > 0) return;
        try vault.execute(address(this), 1 ether, "", deadline, signatures) {}
        catch {
            reentryBlocked = true;
        }
    }
}

/// @notice One test per attack. Each is a class of vulnerability that has
///         drained real multisig wallets or signature-verifying contracts, and
///         each asserts the vault refuses it -- and, where it matters, that the
///         same inputs are otherwise valid, so the refusal is not an accident.
contract MultisigVaultAttackTest is MultisigVaultBase {
    address internal constant ATTACKER = address(0xBAD);

    /// @dev Order of the secp256k1 group.
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        deadline = block.timestamp + 1 hours;
    }

    // --- forging a quorum ------------------------------------------------------

    /// One compromised owner submits their own signature three times.
    function test_Attack_OneSignatureRepeatedAsAQuorum() public {
        bytes32 digest = vault.hashExecute(ATTACKER, 10 ether, "", 0, deadline);
        bytes memory single = _signWith(keys[0], digest);

        bytes[] memory sigs = new bytes[](3);
        (sigs[0], sigs[1], sigs[2]) = (single, single, single);

        vm.expectRevert(
            abi.encodeWithSelector(MultisigVault.SignersNotAscending.selector, owners[0], owners[0])
        );
        vault.execute(ATTACKER, 10 ether, "", deadline, sigs);
        assertEq(ATTACKER.balance, 0);
    }

    /// A quorum signed entirely by keys that are not owners, for any keys.
    function testFuzz_Attack_OutsidersCannotFormAQuorum(uint256 seed) public {
        uint256[] memory outsiderKeys = new uint256[](3);
        address[] memory outsiders = new address[](3);
        for (uint256 i; i < 3; ++i) {
            outsiderKeys[i] = bound(uint256(keccak256(abi.encode(seed, i))), 1, SECP256K1_N - 1);
            outsiders[i] = vm.addr(outsiderKeys[i]);
            vm.assume(!vault.isOwner(outsiders[i]));
        }
        // Sort ascending so the rejection is about ownership, not ordering.
        for (uint256 i = 1; i < 3; ++i) {
            for (uint256 j = i; j > 0 && outsiders[j - 1] > outsiders[j]; --j) {
                (outsiders[j - 1], outsiders[j]) = (outsiders[j], outsiders[j - 1]);
                (outsiderKeys[j - 1], outsiderKeys[j]) = (outsiderKeys[j], outsiderKeys[j - 1]);
            }
        }
        vm.assume(outsiders[0] != outsiders[1] && outsiders[1] != outsiders[2]);

        bytes32 digest = vault.hashExecute(ATTACKER, 1 ether, "", 0, deadline);
        bytes[] memory sigs = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            sigs[i] = _signWith(outsiderKeys[i], digest);
        }

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotAnOwner.selector, outsiders[0]));
        vault.execute(ATTACKER, 1 ether, "", deadline, sigs);
        assertEq(vault.nonce(), 0);
    }

    // --- malformed signatures --------------------------------------------------

    /// For every valid (r, s, v) there is a second valid signature (r, n - s, v')
    /// over the same message. Raw ecrecover accepts both. Anything that treats
    /// a signature as a unique identifier -- "has this signature been used?" --
    /// can be replayed through its twin.
    function test_Attack_MalleatedSignature() public {
        bytes32 digest = vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], digest);

        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        // The twin is genuinely valid to the precompile...
        assertEq(ecrecover(digest, flippedV, r, highS), owners[0]);

        bytes[] memory sigs = _sign(digest, _indices(0, 1, 2));
        sigs[0] = abi.encodePacked(r, highS, flippedV);

        // ...and the vault refuses it outright. This vault keys no state on
        // signatures, so here the check is defence in depth rather than the
        // only thing standing between an attacker and the funds.
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
    }

    /// An all-zero signature makes the ecrecover precompile return address(0).
    /// A contract that compares that against an unset owner slot accepts it.
    function test_Attack_ZeroSignatureRecoversToZeroAddress() public {
        bytes32 digest = vault.hashExecute(ATTACKER, 1 ether, "", 0, deadline);
        assertEq(ecrecover(digest, 27, bytes32(0), bytes32(0)), address(0));

        bytes[] memory sigs = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            sigs[i] = new bytes(65);
        }

        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        vault.execute(ATTACKER, 1 ether, "", deadline, sigs);
    }

    /// The 64-byte EIP-2098 encoding is a second representation of the same
    /// signature -- malleability by another route.
    function test_Attack_CompactSignatureEncoding() public {
        bytes32 digest = vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], digest);
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));

        bytes[] memory sigs = _sign(digest, _indices(0, 1, 2));
        sigs[0] = abi.encodePacked(r, vs);

        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
    }

    /// An owner is tricked into signing the same data through a different
    /// scheme -- a personal_sign prompt instead of typed data.
    function test_Attack_SignatureFromTheWrongScheme() public {
        bytes32 digest = vault.hashExecute(ATTACKER, 1 ether, "", 0, deadline);
        bytes32 personal = MessageHashUtils.toEthSignedMessageHash(digest);

        bytes[] memory sigs = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            sigs[i] = _signWith(keys[i], personal);
        }

        // Recovered against the real digest, it names someone else entirely.
        address impostor = ECDSA.recover(digest, sigs[0]);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotAnOwner.selector, impostor));
        vault.execute(ATTACKER, 1 ether, "", deadline, sigs);
    }

    // --- replay ------------------------------------------------------------------

    /// Signatures collected on one chain, submitted on another where the same
    /// vault address holds funds -- after a hard fork, or on an L2 deployed from
    /// the same factory.
    function test_Attack_CrossChainReplay() public {
        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);
        uint256 home = block.chainid;

        vm.chainId(8453);
        address first =
            ECDSA.recover(vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline), sigs[0]);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotAnOwner.selector, first));
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);

        // The same signatures are valid at home, so the chain id alone refused them.
        vm.chainId(home);
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
        assertEq(RECIPIENT.balance, 1 ether);
    }

    /// A second vault with the same owners, fed signatures meant for the first.
    function test_Attack_CrossVaultReplay() public {
        MultisigVault twin = new MultisigVault(owners, THRESHOLD);
        vm.deal(address(twin), 10 ether);

        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);

        vm.expectRevert();
        twin.execute(RECIPIENT, 1 ether, "", deadline, sigs);
        assertEq(address(twin).balance, 10 ether);

        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
        assertEq(RECIPIENT.balance, 1 ether);
    }

    /// An approval signed in advance for a later nonce, submitted early.
    function test_Attack_FutureNonceSubmittedEarly() public {
        bytes32 digest = vault.hashExecute(ATTACKER, 1 ether, "", 1, deadline);
        bytes[] memory sigs = _sign(digest, _indices(0, 1, 2));

        vm.expectRevert();
        vault.execute(ATTACKER, 1 ether, "", deadline, sigs);
        assertEq(ATTACKER.balance, 0);
    }

    // --- reentrancy and submission -------------------------------------------

    /// The recipient re-enters execute during the payout and tries to spend the
    /// same approval again before the first call has returned.
    function test_Attack_ReentrancyWithTheSameApproval() public {
        Reenterer reenterer = new Reenterer(vault);
        bytes[] memory sigs = _approve(address(reenterer), 1 ether, "", deadline);
        reenterer.arm(deadline, sigs);

        vault.execute(address(reenterer), 1 ether, "", deadline, sigs);

        assertTrue(reenterer.reentryBlocked(), "the nested call must have been refused");
        assertEq(address(reenterer).balance, 1 ether, "paid exactly once");
        assertEq(address(vault).balance, 9 ether);
        assertEq(vault.nonce(), 1);
    }

    /// Anyone can submit an approved call, including someone who watched the
    /// signatures go by. Every parameter is signed, so doing so gains nothing.
    function test_Attack_FrontRunnerSubmitsTheApproval() public {
        bytes[] memory sigs = _approve(RECIPIENT, 2 ether, "", deadline);

        vm.prank(ATTACKER);
        vault.execute(RECIPIENT, 2 ether, "", deadline, sigs);

        assertEq(RECIPIENT.balance, 2 ether);
        assertEq(ATTACKER.balance, 0);
    }

    // --- construction ------------------------------------------------------------

    /// A vault with no owners, which nobody could ever sign for.
    function test_Attack_EmptyOwnerSet() public {
        address[] memory none = new address[](0);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.InvalidThreshold.selector, 1, 0));
        new MultisigVault(none, 1);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.InvalidThreshold.selector, 0, 0));
        new MultisigVault(none, 0);
    }
}
