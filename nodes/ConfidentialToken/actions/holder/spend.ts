import { NodeOperationError } from 'n8n-workflow';
import { StrKey } from '@stellar/stellar-sdk';
import { TransactionBuilder } from 'stellar-sdk-14';

import {
	keypairSigner,
	StateEngine,
	submitMerge,
	type OnChainAccount,
	type Opening,
	type Point,
	type Signer,
} from '../../../../vendor/stellar-confidential-token-sdk/src';
import { NETWORK_PASSPHRASES } from '../../../shared/network';
import {
	checkConfidentialAmount,
	checkConfidentialFee,
	readConfidentialPolicy,
	type Policy,
	type PolicyViolation,
} from '../../../shared/policy';
import { sdkErrorOf, stateErrorOf } from '../common';
import { requireRegistered, syncHolder, tokenInfo } from './holder';
import type { HolderContext, TokenInfo } from './holder';

// What Transfer and Withdraw share (ticket #95): the holder's policy on the plain amounts, the fee
// guard on every transaction the item signs, the automatic merge and the keys the proofs need.

// The error a policy violation becomes. The texts come from nodes/shared/policy.ts and carry no
// amounts, no limits and no fee (ADR 0102, rule 6).
function violationError(holder: HolderContext, violation: PolicyViolation): NodeOperationError {
	return new NodeOperationError(holder.node, violation.message, {
		itemIndex: holder.itemIndex,
		description: violation.description,
	});
}

// Reads the policy from the credential, before anything else: a field that can't be read fails the
// item and never counts as no limit, and neither does a muxed (M) destination, which Transfer can't
// send to. The wording is the Stellar Signer's (StellarSigner.node.ts).
export function readHolderPolicy(holder: HolderContext): Policy {
	const reading = readConfidentialPolicy(holder.credential);
	if ('invalid' in reading) {
		const { field, problem, fix } = reading.invalid;
		throw new NodeOperationError(
			holder.node,
			`'${field}' in the Confidential Token Holder API credential ${problem}`,
			{ itemIndex: holder.itemIndex, description: `${fix} Nothing was proved, signed or sent.` },
		);
	}
	return reading.policy;
}

// A fee that can't be read as a whole number of stroops is -1, which the policy treats as over the
// limit and never as a pass.
function feeOf(xdrBase64: string): bigint {
	try {
		const fee = TransactionBuilder.fromXDR(xdrBase64, NETWORK_PASSPHRASES.testnet).fee;
		return /^\d+$/.test(fee) ? BigInt(fee) : BigInt(-1);
	} catch {
		return BigInt(-1);
	}
}

// Why the fee guard stopped a signature: the fee couldn't be read, or the total is over the limit.
type FeeLimit = 'unread' | 'over';

// A signer that checks the fee before it signs (D-0348). The SDK hands it the assembled
// transaction, whose fee is the inclusion fee plus the resource fee from the simulation, with the
// rent in it. Each fee it sees is added to the item's total, so the automatic merge and the
// transfer or withdrawal count together, and the policy's Maximum Fee is checked against that
// total. Over the limit, it throws and signs nothing.
function feeGuard(holder: HolderContext, policy: Policy): Signer {
	const inner = keypairSigner(holder.secretKey, NETWORK_PASSPHRASES.testnet);
	let total = BigInt(0);
	return {
		publicKey: inner.publicKey,
		async sign(xdrBase64: string): Promise<string> {
			const fee = feeOf(xdrBase64);
			total = fee < BigInt(0) ? fee : total + fee;
			const violation = checkConfidentialFee(policy, total);
			if (violation !== undefined) {
				// Marked so prepareSpend can tell the guard from any other error of the merge, and a fee
				// that couldn't be read from one over the limit.
				const feeLimit: FeeLimit = fee < BigInt(0) ? 'unread' : 'over';
				throw Object.assign(violationError(holder, violation), { feeLimit });
			}
			return await inner.sign(xdrBase64);
		},
	};
}

export interface SpendRequest {
	operation: 'transfer' | 'withdraw';
	stroops: bigint;
	// Where a transfer goes. A withdrawal goes to the holder's own account.
	destination?: string;
}

// What an item already put on the chain before the transfer or withdrawal, so a later failure can
// say it. Only the automatic merge does.
export interface SpendProgress {
	mergeTxHash: string | null;
}

// An item that fails after its automatic merge was applied says so, with the merge's hash: the
// merge is on the chain, and only the item's output would have named it. The error's own text is
// kept, and the note goes at the end of its description. An error of the SDK or of the state is
// turned into the node's own first, so the note isn't lost when forEachItem words it, and then it
// doesn't say that nothing was sent.
export function failureAfterMerge(
	holder: HolderContext,
	error: unknown,
	progress: SpendProgress,
): unknown {
	const failure =
		stateErrorOf(holder.node, error, holder.itemIndex) ??
		sdkErrorOf(holder.node, error, holder.itemIndex, progress.mergeTxHash === null) ??
		error;
	if (progress.mergeTxHash === null || typeof failure !== 'object' || failure === null) {
		return failure;
	}
	const note = `An automatic merge was applied before this failed, in transaction ${progress.mergeTxHash}.`;
	const current =
		'description' in failure && typeof failure.description === 'string'
			? `${failure.description} `
			: '';
	Object.assign(failure, { description: `${current}${note}` });
	return failure;
}

// The fee guard's text says that a proof was discarded and that an earlier merge may have gone
// through. When the guard stops the automatic merge neither is true: no proof exists yet and this is
// the item's first merge. So the error keeps its message and gets a description for this case, which
// says the same as the message: a fee that couldn't be read, or one over the limit. Any other error
// comes back as it is.
function feeLimitOfMerge(node: HolderContext['node'], itemIndex: number, error: unknown): unknown {
	if (typeof error !== 'object' || error === null || !('feeLimit' in error)) {
		return error;
	}
	const unread = error.feeLimit === 'unread';
	return new NodeOperationError(
		node,
		error instanceof Error ? error.message : 'The total fee is over the limit',
		{
			itemIndex,
			description: unread
				? 'The fee of the automatic merge this item needed could not be read to check it against Maximum Fee, so nothing was proved, signed or sent for this item. Run the item again, or merge the received balance first with a Merge, which has no fee limit.'
				: 'The automatic merge this item needed would go over Maximum Fee, so nothing was proved, signed or sent for this item. Raise Maximum Fee, or merge the received balance first with a Merge, which has no fee limit.',
		},
	);
}

export interface SpendPlan {
	info: TokenInfo;
	// Signs for the item's transactions, with the fee guard.
	signer: Signer;
	// The spendable opening to prove from, verified against the chain.
	spendable: Opening;
	senderAuditorKey: Point;
	// The recipient, for a transfer.
	recipient?: OnChainAccount;
	recipientAuditorKey?: Point;
	mergedFirst: boolean;
	mergeTxHash: string | null;
}

// Everything before the proof, in the order that spends nothing until the last step:
//
// 1. the account is registered, and the token's asset is read;
// 2. the policy checks the plain amount and the destination;
// 3. a transfer's destination is registered in the token;
// 4. the state is synced and, if the spendable balance is short but spendable plus received is not,
//    the node merges first (with the same fee guard) and syncs again;
// 5. the spendable opening is verified against the chain, and the auditor keys are read.
//
// The caller holds the account's lock. Nothing here is proved.
export async function prepareSpend(
	holder: HolderContext,
	policy: Policy,
	request: SpendRequest,
	progress: SpendProgress,
): Promise<SpendPlan> {
	const { client, node, itemIndex, contracts, account, keys, store } = holder;
	await requireRegistered(holder);
	const info = await tokenInfo(client, contracts.token, node, itemIndex);

	const violation = checkConfidentialAmount(policy, {
		operation: request.operation,
		asset: info.asset,
		stroops: request.stroops,
		destination: request.destination,
	});
	if (violation !== undefined) {
		throw violationError(holder, violation);
	}

	let recipient: OnChainAccount | undefined;
	if (request.operation === 'transfer') {
		const found = await client.confidentialBalance(request.destination ?? '');
		if (found === null) {
			throw new NodeOperationError(node, "The destination isn't registered in this token", {
				itemIndex,
				description:
					'An account has to register in the token before it can receive a confidential transfer. Ask the owner of the destination to register it. Nothing was proved, signed or sent.',
			});
		}
		recipient = found;
	}

	const signer = feeGuard(holder, policy);
	let { state } = await syncHolder(holder);
	let mergedFirst = false;
	let mergeTxHash: string | null = null;
	if (state.spendable.v < request.stroops) {
		if (state.spendable.v + state.receiving.v < request.stroops) {
			throw new NodeOperationError(node, "The confidential balance isn't enough for this amount", {
				itemIndex,
				description:
					'The spendable balance, even with what the account received merged into it, is below the amount. Nothing was proved, signed or sent. Lower the amount, or deposit more into the confidential balance first.',
			});
		}
		let merged: Awaited<ReturnType<typeof submitMerge>>;
		try {
			merged = await submitMerge(client, signer, account);
		} catch (error) {
			throw feeLimitOfMerge(node, itemIndex, error);
		}
		mergedFirst = true;
		mergeTxHash = merged.hash;
		progress.mergeTxHash = merged.hash;
		// The merge is in the chain, so the sync has to see it: a failed sync fails the item, which
		// can't go on without the new opening.
		({ state } = await syncHolder(holder));
	}

	// The opening comes from the state, checked against the chain before the proof is built
	// (OpenZeppelin, build-with-the-sdk.mdx §5: "spendableForProof()").
	const engine = new StateEngine({
		client,
		store,
		keys,
		address: account,
		fromLedger: state.syncedLedger,
	});
	const spendable = await engine.spendableForProof();

	// The auditor keys come from the chain, as in the guide: each account's auditor ID is on its
	// confidential account.
	const sender = await client.confidentialBalance(account);
	if (sender === null) {
		throw new NodeOperationError(node, "This account isn't registered in this token", {
			itemIndex,
			description: 'Run Register for this account first. Nothing was proved, signed or sent.',
		});
	}
	const senderAuditorKey = await client.auditorKey(sender.auditorId);
	const recipientAuditorKey =
		recipient === undefined ? undefined : await client.auditorKey(recipient.auditorId);

	return {
		info,
		signer,
		spendable,
		senderAuditorKey,
		recipient,
		recipientAuditorKey,
		mergedFirst,
		mergeTxHash,
	};
}

// A destination for Transfer: a G account. A muxed (M) address is not accepted, because the
// token's accounts are G accounts. The text is not repeated in the error.
export function readDestination(
	node: HolderContext['node'],
	value: unknown,
	itemIndex: number,
): string {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!StrKey.isValidEd25519PublicKey(text)) {
		throw new NodeOperationError(node, "'Destination' isn't a valid Stellar account address", {
			itemIndex,
			description:
				'Enter the 56-character address of the account that receives the transfer, starting with G. Muxed (M) addresses are not accepted. Nothing was proved, signed or sent.',
		});
	}
	return text;
}
