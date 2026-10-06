#!/usr/bin/env node
/**
 * decode-1010.mjs: read-only decoder for Midnight node transaction rejections. Turns
 * "1010: Invalid Transaction: Custom error: N" into the ledger error N stands for, using the
 * code table of the node version that rejected the transaction.
 *
 * Give it the error text: a log file, piped output, or the text itself. It finds every
 * `Custom error: N`, every Substrate transaction pool error (1001 to 1021) and every node log
 * line "Rejected transaction <hash> from mempool: Transaction Error: …", and says what each one
 * means. Offline unless you pass --rpc. Nothing is signed or submitted.
 *
 * Requirements: Node >= 20 (global fetch). No npm install.
 *
 * Usage:
 *   node decode-1010.mjs app.log
 *   npm run deploy 2>&1 | node decode-1010.mjs
 *   node decode-1010.mjs 'RpcError: 1010: Invalid Transaction: Custom error: 196'
 *   node decode-1010.mjs 182 --node 2.x
 *   node decode-1010.mjs app.log --rpc https://rpc.preprod.midnight.network
 *   export BLOCKFROST_PROJECT_ID=<your project token>          # never pass it as an argument
 *   node decode-1010.mjs app.log --rpc https://rpc.midnight-mainnet.blockfrost.io
 *
 *   --node  code table: 1.0 (node 1.0.0 to 1.0.400) or 2.x (node 2.x release candidates).
 *           Default 1.0: preview, preprod and mainnet ran node 1.0.400 on 2026-10-06.
 *   --rpc   node RPC URL; reads system_version and picks the table from it.
 *           Use one of --node and --rpc, not both.
 *
 * Exit code: 0 = decoded at least one rejection, 2 = no node rejection found in the input,
 *            1 = could not run (bad arguments, unreadable input, RPC failure). 1 is never a verdict.
 */

import fs from 'node:fs';

// Blockfrost: the key comes from the environment, never from an argument, and is redacted
// from every line printed.
const KEY = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? '';
const redact = (s) => (KEY ? String(s).split(encodeURIComponent(KEY)).join('<key>').split(KEY).join('<key>') : String(s));
const fail = (msg) => {
  console.error(redact(msg));
  process.exit(1);
};

if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node >= 20 is required (this is ${process.version})`);

const USAGE = 'usage: node decode-1010.mjs [--node 1.0|2.x | --rpc <url>] [<file> | <text> | <code>] …  (or pipe text in)';

// ---------- code tables ----------
// Generated from `impl From<LedgerApiError> for u8` in midnight-node, not typed by hand:
//   NODE_1_0: tag node-1.0.400 (3acfd2edecdcd91373b6a506933f4c14ad3f0308),
//             ledger/src/versions/common/types.rs. node-1.0.0, 1.0.2 and 1.0.300 are identical.
//   NODE_2_X: tag node-2.1.0-rc.4 (1b2b31c714f8986a082b8690f15e805981c771dd),
//             ledger/src/ledger_8/types.rs (ledger_9/types.rs is identical, and so is main at
//             b2f85e1626edb8dec8e49841e69f95943ec7b4e0). node-2.0.0-rc.4 lacks only 140.
// Names drop the leading `Transaction.`: `Malformed.X` is LedgerApiError::Transaction(Malformed(X)).
const NODE_1_0 = {
  0: 'Deserialization.NetworkId', 1: 'Deserialization.Transaction',
  2: 'Deserialization.DeserializationLedgerState',
  3: 'Deserialization.DeserializationContractAddress', 4: 'Deserialization.PublicKey',
  5: 'Deserialization.VersionedArenaKey', 6: 'Deserialization.UserAddress',
  7: 'Deserialization.TypedArenaKey', 8: 'Deserialization.SystemTransaction',
  9: 'Deserialization.DustPublicKey', 10: 'Deserialization.CNightGeneratesDustActionType',
  11: 'Deserialization.CNightGeneratesDustEvent', 50: 'Serialization.TransactionIdentifier',
  51: 'Serialization.SerializationLedgerState', 52: 'Serialization.LedgerParameters',
  53: 'Serialization.SerializationContractAddress', 54: 'Serialization.ContractState',
  55: 'Serialization.ContractStateToJson', 56: 'Serialization.ZswapState',
  57: 'Serialization.UnknownType', 58: 'Serialization.MerkleTreeDigest',
  59: 'Serialization.VersionedArenaKey', 60: 'Serialization.TypedArenaKey',
  61: 'Serialization.CNightGeneratesDustEvent', 62: 'Serialization.SystemTransaction',
  63: 'Serialization.ArenaHash', 100: 'Invalid.EffectsMismatch',
  101: 'Invalid.ContractAlreadyDeployed', 102: 'Invalid.ContractNotPresent', 103: 'Invalid.Zswap',
  104: 'Invalid.Transcript', 105: 'Invalid.InsufficientClaimable',
  106: 'Invalid.VerifierKeyNotFound', 107: 'Invalid.VerifierKeyAlreadyPresent',
  108: 'Invalid.ReplayCounterMismatch', 109: 'Invalid.UnknownError',
  110: 'Malformed.VerifierKeyNotSet', 111: 'Malformed.TransactionTooLarge',
  112: 'Malformed.VerifierKeyTooLarge', 113: 'Malformed.VerifierKeyNotPresent',
  114: 'Malformed.ContractNotPresent', 115: 'Malformed.InvalidProof',
  116: 'Malformed.BindingCommitmentOpeningInvalid', 117: 'Malformed.NotNormalized',
  118: 'Malformed.FallibleWithoutCheckpoint', 119: 'Malformed.ClaimReceiveFailed',
  120: 'Malformed.ClaimSpendFailed', 121: 'Malformed.ClaimNullifierFailed',
  122: 'Malformed.ClaimCallFailed', 123: 'Malformed.InvalidSchnorrProof',
  124: 'Malformed.UnclaimedCoinCom', 125: 'Malformed.UnclaimedNullifier',
  126: 'Malformed.Unbalanced', 127: 'Malformed.Zswap', 128: 'Malformed.BuiltinDecode',
  129: 'Malformed.GuaranteedLimit', 130: 'Malformed.MergingContracts',
  131: 'Malformed.CantMergeTypes', 132: 'Malformed.ClaimOverflow',
  133: 'Malformed.ClaimCoinMismatch', 134: 'Malformed.KeyNotInCommittee',
  135: 'Malformed.InvalidCommitteeSignature', 136: 'Malformed.ThresholdMissed',
  137: 'Malformed.TooManyZswapEntries', 138: 'Malformed.BalanceCheckOverspend',
  139: 'Malformed.UnknownError', 150: 'LedgerCacheError', 151: 'NoLedgerState',
  152: 'LedgerStateScaleDecodingError', 153: 'ContractCallCostError',
  154: 'BlockLimitExceededError', 155: 'FeeCalculationError', 165: 'GetTransactionContextError',
  166: 'Malformed.InvalidNetworkId', 167: 'Malformed.IllegallyDeclaredGuaranteed',
  168: 'Malformed.FeeCalculation', 169: 'Malformed.InvalidDustRegistrationSignature',
  170: 'Malformed.InvalidDustSpendProof', 171: 'Malformed.OutOfDustValidityWindow',
  172: 'Malformed.MultipleDustRegistrationsForKey',
  173: 'Malformed.InsufficientDustForRegistrationFee', 174: 'Malformed.MalformedContractDeploy',
  175: 'Malformed.IntentSignatureVerificationFailure', 176: 'Malformed.IntentSignatureKeyMismatch',
  177: 'Malformed.IntentSegmentIdCollision', 178: 'Malformed.IntentAtGuaranteedSegmentId',
  179: 'Malformed.UnsupportedProofVersion', 180: 'Malformed.GuaranteedTranscriptVersion',
  181: 'Malformed.FallibleTranscriptVersion', 182: 'Malformed.TransactionApplicationError',
  183: 'Malformed.BalanceCheckOutOfBounds', 184: 'Malformed.BalanceCheckConversionFailure',
  185: 'Malformed.PedersenCheckFailure', 186: 'Malformed.EffectsCheckFailure',
  187: 'Malformed.DisjointCheckFailure', 188: 'Malformed.SequencingCheckFailure',
  189: 'Malformed.InputsNotSorted', 190: 'Malformed.OutputsNotSorted',
  191: 'Malformed.DuplicateInputs', 192: 'Malformed.InputsSignaturesLengthMismatch',
  193: 'Invalid.ReplayProtectionViolation', 194: 'Invalid.BalanceCheckOutOfBounds',
  195: 'Invalid.InputNotInUtxos', 196: 'Invalid.DustDoubleSpend',
  197: 'Invalid.DustDeregistrationNotRegistered', 198: 'Invalid.GenerationInfoAlreadyPresent',
  199: 'Invalid.InvariantViolation', 200: 'Invalid.RewardTooSmall',
  201: 'SystemTransaction.IllegalPayout', 202: 'SystemTransaction.InsufficientTreasuryFunds',
  203: 'SystemTransaction.CommitmentAlreadyPresent', 204: 'SystemTransaction.UnknownError',
  205: 'SystemTransaction.ReplayProtectionFailure',
  206: 'SystemTransaction.IllegalReserveDistribution',
  207: 'SystemTransaction.GenerationInfoAlreadyPresent',
  208: 'SystemTransaction.InvalidBasisPoints', 209: 'SystemTransaction.InvariantViolation',
  210: 'SystemTransaction.TreasuryDisabled', 211: 'SystemTransaction.MerkleTreeError',
  255: 'HostApiError'
};
const NODE_2_X = {
  0: 'Deserialization.NetworkId', 1: 'Deserialization.Transaction',
  2: 'Deserialization.DeserializationLedgerState',
  3: 'Deserialization.DeserializationContractAddress', 4: 'Deserialization.PublicKey',
  5: 'Deserialization.VersionedArenaKey', 6: 'Deserialization.UserAddress',
  7: 'Deserialization.TypedArenaKey', 8: 'Deserialization.SystemTransaction',
  9: 'Deserialization.DustPublicKey', 10: 'Deserialization.CNightGeneratesDustActionType',
  11: 'Deserialization.CNightGeneratesDustEvent', 50: 'Serialization.TransactionIdentifier',
  51: 'Serialization.SerializationLedgerState', 52: 'Serialization.LedgerParameters',
  53: 'Serialization.SerializationContractAddress', 54: 'Serialization.ContractState',
  55: 'Serialization.ContractStateToJson', 56: 'Serialization.ZswapState',
  57: 'Serialization.UnknownType', 58: 'Serialization.MerkleTreeDigest',
  59: 'Serialization.VersionedArenaKey', 60: 'Serialization.TypedArenaKey',
  61: 'Serialization.CNightGeneratesDustEvent', 62: 'Serialization.SystemTransaction',
  63: 'Serialization.ArenaHash', 100: 'Invalid.EffectsMismatch',
  101: 'Invalid.ContractAlreadyDeployed', 102: 'Invalid.ContractNotPresent',
  103: 'Invalid.Zswap.Unknown', 104: 'Invalid.Transcript', 105: 'Invalid.InsufficientClaimable',
  106: 'Invalid.VerifierKeyNotFound', 107: 'Invalid.VerifierKeyAlreadyPresent',
  108: 'Invalid.ReplayCounterMismatch', 109: 'Invalid.UnknownError',
  110: 'Malformed.VerifierKeyNotSet', 111: 'Malformed.TransactionTooLarge',
  112: 'Malformed.VerifierKeyTooLarge', 113: 'Malformed.VerifierKeyNotPresent',
  114: 'Malformed.ContractNotPresent', 115: 'Malformed.InvalidProof',
  116: 'Malformed.BindingCommitmentOpeningInvalid', 117: 'Malformed.NotNormalized',
  118: 'Malformed.FallibleWithoutCheckpoint', 119: 'Malformed.ClaimReceiveFailed',
  120: 'Malformed.ClaimSpendFailed', 121: 'Malformed.ClaimNullifierFailed',
  122: 'Malformed.ClaimCallFailed', 123: 'Malformed.InvalidSchnorrProof',
  124: 'Malformed.UnclaimedCoinCom', 125: 'Malformed.UnclaimedNullifier',
  126: 'Malformed.Unbalanced', 127: 'Malformed.Zswap.Unknown', 128: 'Malformed.BuiltinDecode',
  129: 'Malformed.GuaranteedLimit', 130: 'Malformed.MergingContracts',
  131: 'Malformed.CantMergeTypes', 132: 'Malformed.ClaimOverflow',
  133: 'Malformed.ClaimCoinMismatch', 134: 'Malformed.KeyNotInCommittee',
  135: 'Malformed.InvalidCommitteeSignature', 136: 'Malformed.ThresholdMissed',
  137: 'Malformed.TooManyZswapEntries', 138: 'Malformed.BalanceCheckOverspend',
  139: 'Malformed.UnknownError', 140: 'SystemTransaction.NotAllowedForCaller',
  150: 'LedgerCacheError', 151: 'NoLedgerState', 152: 'LedgerStateScaleDecodingError',
  153: 'ContractCallCostError', 154: 'BlockLimitExceededError', 155: 'FeeCalculationError',
  156: 'ContractNotPresent', 157: 'BeneficiaryNotFound', 165: 'GetTransactionContextError',
  166: 'Malformed.InvalidNetworkId', 167: 'Malformed.IllegallyDeclaredGuaranteed',
  169: 'Malformed.InvalidDustRegistrationSignature', 170: 'Malformed.InvalidDustSpendProof',
  171: 'Malformed.OutOfDustValidityWindow', 172: 'Malformed.MultipleDustRegistrationsForKey',
  173: 'Malformed.InsufficientDustForRegistrationFee',
  174: 'Malformed.MalformedContractDeploy.Unknown',
  175: 'Malformed.IntentSignatureVerificationFailure', 176: 'Malformed.IntentSignatureKeyMismatch',
  177: 'Malformed.IntentSegmentIdCollision', 178: 'Malformed.IntentAtGuaranteedSegmentId',
  179: 'Malformed.UnsupportedProofVersion', 180: 'Malformed.GuaranteedTranscriptVersion',
  181: 'Malformed.FallibleTranscriptVersion', 183: 'Malformed.BalanceCheckOutOfBounds',
  184: 'Malformed.BalanceCheckConversionFailure', 185: 'Malformed.PedersenCheckFailure',
  189: 'Malformed.InputsNotSorted', 190: 'Malformed.OutputsNotSorted',
  191: 'Malformed.DuplicateInputs', 192: 'Malformed.InputsSignaturesLengthMismatch',
  194: 'Invalid.BalanceCheckOutOfBounds', 195: 'Invalid.InputNotInUtxos',
  196: 'Invalid.DustDoubleSpend', 197: 'Invalid.DustDeregistrationNotRegistered',
  198: 'Invalid.GenerationInfoAlreadyPresent', 199: 'Invalid.InvariantViolation',
  200: 'Invalid.RewardTooSmall', 201: 'SystemTransaction.IllegalPayout',
  202: 'SystemTransaction.InsufficientTreasuryFunds',
  203: 'SystemTransaction.CommitmentAlreadyPresent', 204: 'SystemTransaction.UnknownError',
  206: 'SystemTransaction.IllegalReserveDistribution',
  207: 'SystemTransaction.GenerationInfoAlreadyPresent',
  208: 'SystemTransaction.InvalidBasisPoints', 209: 'SystemTransaction.InvariantViolation',
  210: 'SystemTransaction.TreasuryDisabled', 211: 'SystemTransaction.MerkleTreeError',
  212: 'Malformed.EffectsCheck.RealCallsSubsetCheckFailure',
  213: 'Malformed.EffectsCheck.AllCommitmentsSubsetCheckFailure',
  214: 'Malformed.EffectsCheck.RealUnshieldedSpendsSubsetCheckFailure',
  215: 'Malformed.EffectsCheck.ClaimedUnshieldedSpendsUniquenessFailure',
  216: 'Malformed.EffectsCheck.ClaimedCallsUniquenessFailure',
  217: 'Malformed.EffectsCheck.NullifiersNeqClaimedNullifiers',
  218: 'Malformed.EffectsCheck.CommitmentsNeqClaimedShieldedReceives',
  219: 'Malformed.SequencingCheck.CallSequencingViolation',
  220: 'Malformed.SequencingCheck.SequencingCorrelationViolation',
  221: 'Malformed.SequencingCheck.GuaranteedInFallibleContextViolation',
  222: 'Malformed.SequencingCheck.FallibleInGuaranteedContextViolation',
  223: 'Malformed.SequencingCheck.CausalityConstraintViolation',
  224: 'Malformed.SequencingCheck.CallHasEmptyTranscripts',
  225: 'Malformed.DisjointCheck.ShieldedInputsDisjointFailure',
  226: 'Malformed.DisjointCheck.ShieldedOutputsDisjointFailure',
  227: 'Malformed.DisjointCheck.UnshieldedInputsDisjointFailure',
  228: 'Malformed.TransactionApplication.IntentTtlExpired',
  229: 'Malformed.TransactionApplication.IntentTtlTooFarInFuture',
  230: 'Malformed.TransactionApplication.IntentAlreadyExists',
  231: 'Malformed.FeeCalculation.OutsideTimeToDismiss',
  232: 'Malformed.FeeCalculation.BlockLimitExceeded',
  233: 'Malformed.MalformedContractDeploy.NonZeroBalance',
  234: 'Malformed.MalformedContractDeploy.IncorrectChargedState',
  235: 'Malformed.Zswap.InvalidProof', 236: 'Malformed.Zswap.ContractSentCiphertext',
  237: 'Malformed.Zswap.NonDisjointCoinMerge', 238: 'Malformed.Zswap.NotNormalized',
  239: 'Invalid.Zswap.NullifierAlreadyPresent', 240: 'Invalid.Zswap.CommitmentAlreadyPresent',
  241: 'Invalid.Zswap.UnknownMerkleRoot',
  242: 'Invalid.ReplayProtectionViolation.IntentTtlExpired',
  243: 'Invalid.ReplayProtectionViolation.IntentTtlTooFarInFuture',
  244: 'Invalid.ReplayProtectionViolation.IntentAlreadyExists',
  245: 'SystemTransaction.ReplayProtectionFailure.IntentTtlExpired',
  246: 'SystemTransaction.ReplayProtectionFailure.IntentTtlTooFarInFuture',
  247: 'SystemTransaction.ReplayProtectionFailure.IntentAlreadyExists',
  248: 'Invalid.DivideByZero', 249: 'Invalid.MerkleTreeError',
  250: 'Invalid.Zswap.MerkleTreeError', 255: 'HostApiError'
};

const TABLES = {
  '1.0': { table: NODE_1_0, label: 'node 1.0.x', range: '1.0.0 to 1.0.400' },
  '2.x': { table: NODE_2_X, label: 'node 2.x', range: '2.0.0-rc.4 to 2.1.0-rc.4, release candidates' },
};

const CATEGORY = {
  Deserialization: 'the node could not decode part of the transaction it was sent.',
  Serialization: 'the node failed to serialize a value while validating the transaction.',
  Invalid: 'the transaction is well-formed but conflicts with the ledger state it was checked against.',
  Malformed: "the transaction failed the ledger's well-formedness checks (structure, proofs, signatures, balance, TTL, fees).",
  SystemTransaction: "a system transaction error. DApps and wallets don't send system transactions; check the node log.",
  node: "the node's ledger API failed while validating, outside the ledger's own checks. The node log has the details.",
};

// What the codes people actually hit mean in practice, and what to do. Only codes with a
// reproduction or a worked servicedesk case are here; the rest get their name and category.
const TTL_FIX =
  "Fix: build the transaction again with a TTL a little in the future (now + 30 minutes was accepted), and don't submit a transaction built long ago.";
const TTL_182 = `Intent TTL expired, TTL too far in the future, or intent already exists. The node log says which and gives the times ("Intent TTL has expired. TTL: …, Current block: …" or "Intent TTL is too far in the future. TTL: …, Maximum allowed: …"). Reproduced on node 1.0.400 with a TTL 5 minutes in the past and one 30 days ahead. ${TTL_FIX}`;
const REPLAY_193 =
  'Replay protection, checked against ledger state: most often the intent is already on chain. Reproduced on node 1.0.400 by submitting a transaction again after it was included (node log: "guaranteed execution would fail: ReplayProtectionViolation(IntentAlreadyExists)"). The common cause is a retry that resubmits a transaction that already landed: look the first one up on the indexer before retrying, and build a new transaction for a real retry.';
const DUST_196 =
  'The DUST that pays the fee is already spent. Reproduced on node 1.0.400 with two wallet instances on one seed, before and after the first transaction landed. Fix: one wallet instance per seed, and let the wallet sync its last transaction before building the next one.';
const DUST_170 =
  "The DUST spend proof that pays the fee did not verify. The ledger's own text: \"this is just as likely a disagreement on dust state on the declared time as the proof being invalid\". Let the wallet finish syncing and build again. If every transaction on the network gets 170, faucet included, the network's DUST state is the problem (servicedesk#150). A client on a different ledger version than the network is the other known cause (servicedesk#52; see the toolchain-version-mismatch runbook).";
const DISMISS_TEXT = '"exceeded the maximum time to dismiss for transaction size"';
const BLOCK_TEXT = '"exceeded block limit in transaction fee computation"';
const HINTS = {
  '1.0': {
    166: "Built for a different network than the node's. Check the network id the DApp and wallet use.",
    168: `Fee check. On node 1.0.x this one code covers two ledger errors, and the node log says which: ${DISMISS_TEXT} (the transaction would take longer to validate than its size allows; servicedesk#100, a three-intent swap) or ${BLOCK_TEXT} (too big for one block; for a contract deploy, see the contract-batched-deploy runbook). servicedesk#54 saw 168 with an 8.0.3 client on an 8.0.2 node (not reproduced); see the toolchain-version-mismatch runbook.`,
    170: DUST_170,
    182: TTL_182,
    186: "The transaction's effects don't match what its contract calls claim. servicedesk#37: midnight-js 4.0.4 put the offer for a fallible claim in the guaranteed section; midnight-js 4.1.1 fixed it.",
    193: REPLAY_193,
    196: DUST_196,
  },
  '2.x': {
    166: "Built for a different network than the node's. Check the network id the DApp and wallet use.",
    170: DUST_170,
    196: DUST_196,
    228: `Intent TTL expired. On node 1.0.x this was 182, reproduced there with a TTL 5 minutes in the past. ${TTL_FIX}`,
    229: `Intent TTL too far in the future. On node 1.0.x this was 182, reproduced there with a TTL 30 days ahead. ${TTL_FIX}`,
    230: 'Intent already exists. On node 1.0.x this was 182.',
    231: `Node log: ${DISMISS_TEXT}. The transaction would take longer to validate than its size allows. servicedesk#117 (node 2.0.0-rc.4): contract calls that use unshielded-token effects. On node 1.0.x this was 168 (servicedesk#100, a three-intent swap).`,
    232: `Node log: ${BLOCK_TEXT}. Too big for one block; for a contract deploy, see the contract-batched-deploy runbook. On node 1.0.x this was 168.`,
    242: `Replay protection, checked against ledger state: intent TTL expired. On node 1.0.x this was 193. ${TTL_FIX}`,
    243: `Replay protection, checked against ledger state: intent TTL too far in the future. On node 1.0.x this was 193. ${TTL_FIX}`,
    244: 'Replay protection, checked against ledger state: this intent is already on chain. On node 1.0.x this was 193, reproduced there by submitting a transaction again after it was included. Look the first one up on the indexer before retrying, and build a new transaction for a real retry.',
  },
};

// Node 1.0.x codes that node 2.x split into finer ones (same source as the tables).
const SPLIT = {
  103: [239, 240, 241, 250], 127: [235, 236, 237, 238], 168: [231, 232], 174: [233, 234],
  182: [228, 229, 230], 186: [212, 213, 214, 215, 216, 217, 218], 187: [225, 226, 227],
  188: [219, 220, 221, 222, 223, 224], 193: [242, 243, 244], 205: [245, 246, 247],
};
const SPLIT_FROM = Object.fromEntries(Object.entries(SPLIT).flatMap(([old, news]) => news.map((n) => [n, Number(old)])));

// Substrate transaction pool errors (polkadot-sdk polkadot-stable2603,
// substrate/client/rpc-api/src/author/error.rs). The RPC message for each is quoted.
const POOL = {
  1001: ['Extrinsic has invalid format', 'The node could not decode the extrinsic at all.'],
  1002: ['Verification Error', 'The extrinsic failed verification before it reached the pool.'],
  1010: ['Invalid Transaction', 'The node rejected the transaction.'],
  1011: ['Unknown Transaction Validity', "The node couldn't decide whether the transaction is valid; the data field has the reason."],
  1012: ['Transaction is temporarily banned', 'The pool refuses this exact transaction for now. Build a new transaction instead of resubmitting the same one.'],
  1013: ['Transaction Already Imported', 'This exact transaction is already in the pool. Wait for it instead of resubmitting.'],
  1014: ['Priority is too low', 'The transaction has too low priority to replace another transaction already in the pool.'],
  1015: ['Cycle Detected', 'The pool found a dependency cycle between transactions.'],
  1016: ['Immediately Dropped', "The transaction couldn't enter the pool because of the pool's limit. Retry later."],
  1018: ['Unactionable', 'The transaction is not propagable and the node does not author blocks.'],
  1019: ['No tags provided', "The transaction provides no tags, so the pool can't identify it."],
  1020: ['The provided block ID is not valid', 'The block the transaction refers to is not valid.'],
  1021: ['The pool is not accepting future transactions', 'The pool does not accept transactions that are not valid yet.'],
};
const POOL_RE = new RegExp(
  `\\b(10[0-2]\\d): (${Object.values(POOL).map(([m]) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?::\\s*([^\\n]*))?`,
  'g',
);
const JSON_RE = /"code"\s*:\s*(10[0-2]\d)\s*,\s*"message"\s*:\s*"([^"]*)"(?:\s*,\s*"data"\s*:\s*"([^"]*)")?/g;
const CUSTOM_RE = /Custom error: (\d+)/g;
// Node log, two forms (node 1.0.400): well-formedness failures print
// "… from mempool: Transaction Error: Malformed(TransactionApplicationError)", ledger-state
// failures "… from mempool: guaranteed execution would fail: DustDoubleSpend(DustNullifier(…))".
const NODE_LOG_RE = /Rejected transaction (?:0x)?([0-9a-fA-F]{8,}) from mempool: (Transaction Error: |guaranteed execution would fail: )([A-Za-z]+(?:\([A-Za-z]+)*)/g;
const WRAPPER_RE = /Transaction submission (error|failed)|SubmissionError|Unexpected error submitting scoped transaction/;

// ---------- arguments ----------
const args = process.argv.slice(2);
let nodeOpt;
let rpcOpt;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--node' || a === '--rpc') {
    const v = args[++i];
    if (!v || v.startsWith('--')) fail(`${a} needs a value\n${USAGE}`);
    if (a === '--node') nodeOpt = v;
    else rpcOpt = v;
  } else if (a.startsWith('--')) {
    fail(`unknown option ${a}\n${USAGE}`);
  } else {
    inputs.push(a);
  }
}
if (nodeOpt && rpcOpt) fail('use --node or --rpc, not both');
if (nodeOpt && !TABLES[nodeOpt]) fail(`--node must be one of: ${Object.keys(TABLES).join(', ')}`);

const withKey = (url) => {
  if (!KEY || url.includes('project_id=')) return url;
  if (!new URL(url).hostname.endsWith('blockfrost.io')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(KEY)}`;
};

async function systemVersion(url) {
  try {
    new URL(url);
  } catch {
    fail(`--rpc is not a URL: ${url}`);
  }
  let res;
  try {
    res = await fetch(withKey(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_version', params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    fail(`could not reach ${url}: ${e.message}`);
  }
  if (!res.ok) {
    const why = KEY ? 'Blockfrost rejected BLOCKFROST_PROJECT_ID; tokens are per network' : 'Blockfrost needs BLOCKFROST_PROJECT_ID';
    fail(`${url}: HTTP ${res.status}${res.status === 403 ? ` (${why})` : ''}`);
  }
  const body = await res.json().catch(() => undefined);
  if (typeof body?.result !== 'string') fail(`${url}: not a system_version response`);
  return body.result;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- decoding ----------
const list = (xs) => (xs.length === 1 ? `${xs[0]}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
// Wrap indented lines at 100 columns, keeping the indent.
const wrap = (line, width = 100) => {
  const indent = line.match(/^\s*/)[0];
  const words = line.trim().split(/\s+/);
  const lines = [];
  let cur = indent;
  for (const w of words) {
    if (cur.trim() && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = `${indent}${w}`;
    } else cur = cur.trim() ? `${cur} ${w}` : `${indent}${w}`;
  }
  lines.push(cur);
  return lines.join('\n');
};
const otherKey = (k) => (k === '1.0' ? '2.x' : '1.0');

function decodeCustom(code, key) {
  const { table } = TABLES[key];
  const other = TABLES[otherKey(key)];
  const out = [];
  const name = table[code];
  if (!name) {
    out.push(`Custom error: ${code}  →  not a code on ${TABLES[key].label}.`);
    if (other.table[code]) {
      const was = key === '1.0' && SPLIT_FROM[code] !== undefined ? ` On ${TABLES[key].label} the same failure is ${SPLIT_FROM[code]} (${table[SPLIT_FROM[code]]}).` : '';
      const now = key === '2.x' && SPLIT[code] ? ` On ${TABLES[key].label} the same failures are ${list(SPLIT[code])}.` : '';
      out.push(`  On ${other.label} it is ${other.table[code]}.${was}${now} Check which node rejected the transaction (--rpc).`);
    } else {
      out.push('  Not on any node line this script knows either. Decode it against the source of the node that rejected it.');
    }
    return out;
  }
  const head = name.includes('.') ? name.split('.')[0] : 'node';
  out.push(`Custom error: ${code}  →  ${name}`);
  out.push(`  ${head === 'node' ? 'Node' : head}: ${CATEGORY[head] ?? CATEGORY.node}`);
  const hint = HINTS[key][code];
  if (hint) out.push(`  ${hint}`);
  const there = other.table[code];
  if (there !== name) {
    const split = key === '1.0' && SPLIT[code] ? ` The same failures are ${list(SPLIT[code])} there.` : '';
    out.push(`  On ${other.label}: ${there ? `${code} is ${there}` : `${code} is not used`}.${split}`);
  }
  return out;
}

// "Malformed(TransactionApplicationError)" → the code with that name in the table, falling back
// to the longest known prefix ("Malformed(FeeCalculation(OutsideTimeToDismiss))" on node 1.0.x).
function codeForVariant(variant, key) {
  const parts = variant.match(/[A-Za-z]+/g) ?? [];
  const byName = new Map(Object.entries(TABLES[key].table).map(([c, n]) => [n, Number(c)]));
  for (let n = parts.length; n > 0; n--) {
    const code = byName.get(parts.slice(0, n).join('.'));
    if (code !== undefined) return code;
  }
  return undefined;
}

function poolLine(code, message, data) {
  const reason = (data ?? '').replace(/\s*:\s*\(FiberFailure\)[\s\S]*$/, '').replace(/["'\s]+$/, '').trim();
  const out = [`${code}: ${message}${reason ? `: ${reason}` : ''}`];
  const meaning = POOL[code]?.[1];
  if (code === 1010 && data === null) {
    out.push('  1010 is the envelope: the node rejected the transaction. The number after "Custom error:" says why; pass that, or the whole error text.');
  } else if (code === 1010) {
    out.push(
      /exhaust the block limits/.test(reason)
        ? '  Too big for one block. For a contract deploy, see the contract-batched-deploy runbook (servicedesk#225).'
        : '  A Substrate check rejected the transaction before the Midnight ledger checked it; the text after the colon is the reason.',
    );
  } else if (meaning) {
    out.push(`  ${meaning}`);
  }
  return out;
}

async function main() {
  // Collect the text to scan.
  const texts = [];
  const codes = new Set();
  for (const inp of inputs) {
    if (fs.existsSync(inp) && fs.statSync(inp).isFile()) {
      try {
        texts.push(fs.readFileSync(inp, 'utf8'));
      } catch (e) {
        fail(`could not read ${inp}: ${e.message}`);
      }
    } else if (/^\d+$/.test(inp)) {
      codes.add(Number(inp));
    } else {
      texts.push(inp);
    }
  }
  if (!inputs.length) {
    if (process.stdin.isTTY) fail(USAGE);
    texts.push(await readStdin());
  }
  const text = texts.join('\n');

  // Which table.
  let key = nodeOpt ?? '1.0';
  const header = [];
  if (rpcOpt) {
    const ver = await systemVersion(rpcOpt);
    const [maj, min] = ver.split(/[.-]/).map(Number);
    if (maj === 1 && min === 0) key = '1.0';
    else if (maj === 2) key = '2.x';
    else fail(`${redact(rpcOpt)} runs node ${ver}; this script has no code table for it. Decode against that node's ledger/src/**/types.rs.`);
    header.push(`Code table: ${TABLES[key].label} (${TABLES[key].range}). ${redact(rpcOpt)} runs ${ver}.`);
  } else if (nodeOpt) {
    header.push(`Code table: ${TABLES[key].label} (${TABLES[key].range}), from --node ${key}.`);
  } else {
    header.push(`Code table: ${TABLES[key].label} (${TABLES[key].range}); preview, preprod and mainnet ran 1.0.400 on 2026-10-06.`);
    header.push('  Check the node that rejected the transaction with --rpc <url>, or pass --node 2.x.');
  }

  // Bare numbers: 0-255 are ledger codes, 1000-1099 pool codes.
  const custom = new Set();
  const pool = new Map(); // "code|message|reason" → [code, message, data]
  for (const c of codes) {
    if (c <= 255) custom.add(c);
    else if (POOL[c]) pool.set(`${c}||`, [c, POOL[c][0], null]);
    else fail(`${c} is neither a node ledger code (0-255) nor a transaction pool code (1001-1021)`);
  }
  for (const m of text.matchAll(CUSTOM_RE)) custom.add(Number(m[1]));
  for (const re of [POOL_RE, JSON_RE]) {
    for (const m of text.matchAll(re)) {
      const [code, message, data] = [Number(m[1]), m[2], m[3] ?? ''];
      if (code === 1010 && /^\s*Custom error: \d+/.test(data)) continue; // decoded below
      const reason = data.replace(/\s*:\s*\(FiberFailure\)[\s\S]*$/, '').trim();
      pool.set(`${code}|${message}|${reason}`, [code, message, data]);
    }
  }
  const nodeLog = new Map(); // variant → hashes
  for (const m of text.matchAll(NODE_LOG_RE)) {
    const variant = m[2].startsWith('guaranteed') ? `Invalid(${m[3]}` : m[3];
    if (!nodeLog.has(variant)) nodeLog.set(variant, new Set());
    nodeLog.get(variant).add(m[1].toLowerCase());
  }

  const blocks = [];
  for (const c of [...custom].sort((a, b) => a - b)) {
    if (c > 255) {
      blocks.push([`Custom error: ${c}  →  not a node ledger code: those are 0 to 255. Look for the 1010 response elsewhere in the error.`]);
      continue;
    }
    blocks.push(decodeCustom(c, key));
  }
  for (const [code, message, data] of pool.values()) blocks.push(poolLine(code, message, data));
  for (const [raw, hashes] of nodeLog) {
    const code = codeForVariant(raw, key);
    const variant = raw + ')'.repeat((raw.match(/\(/g) ?? []).length);
    const tx = hashes.size > 1 ? `${hashes.size} transactions` : `transaction ${[...hashes][0].slice(0, 12)}…`;
    blocks.push(
      code === undefined
        ? [`Node log: ${variant}, ${tx}  →  no matching name on ${TABLES[key].label}.`]
        : [`Node log: ${variant}, ${tx}  →  Custom error: ${code}`, ...(custom.has(code) ? [] : decodeCustom(code, key).slice(1))],
    );
  }

  console.log(header.map((l) => wrap(l)).join('\n'));
  if (!blocks.length) {
    console.log('\nNo node rejection found in the input.');
    if (WRAPPER_RE.test(text)) {
      console.log(
        wrap(
          "The text has the wallet SDK's wrapper but not the node's code: err.message, err.stack and JSON.stringify(err) drop it. Print String(err) or console.error(err) instead, or find the console line that starts with \"RPC-CORE: submitAndWatchExtrinsic\", and run this script on that.",
        ),
      );
    }
    process.exit(2);
  }
  for (const b of blocks) console.log(`\n${b.map((l) => wrap(l)).join('\n')}`);
  process.exit(0);
}

main().catch((e) => fail(`decode-1010 crashed: ${e?.stack ?? e}`));
