import type { Transaction } from '@stellar/stellar-sdk';

// The signing policy: the limits that the Stellar Wallet API credential puts on what the node
// signs. This module doesn't depend on n8n. It reads the credential's fields and checks a decoded
// transaction against them.

// The operation types of Stellar SDK 17.1.0, as it names each operation of a decoded transaction.
const OPERATION_TYPES = [
	'createAccount',
	'payment',
	'pathPaymentStrictReceive',
	'pathPaymentStrictSend',
	'manageSellOffer',
	'manageBuyOffer',
	'createPassiveSellOffer',
	'setOptions',
	'changeTrust',
	'allowTrust',
	'accountMerge',
	'inflation',
	'manageData',
	'bumpSequence',
	'createClaimableBalance',
	'claimClaimableBalance',
	'beginSponsoringFutureReserves',
	'endSponsoringFutureReserves',
	'revokeAccountSponsorship',
	'revokeTrustlineSponsorship',
	'revokeOfferSponsorship',
	'revokeDataSponsorship',
	'revokeClaimableBalanceSponsorship',
	'revokeLiquidityPoolSponsorship',
	'revokeSignerSponsorship',
	'clawback',
	'clawbackClaimableBalance',
	'setTrustLineFlags',
	'liquidityPoolDeposit',
	'liquidityPoolWithdraw',
	'invokeHostFunction',
	'extendFootprintTtl',
	'restoreFootprint',
];

const ALLOWED_OPERATIONS = 'Allowed Operations';
const HOW_TO_WRITE_OPERATIONS =
	'Write one operation type per line, with the names the Stellar SDK uses, such as payment, createAccount or pathPaymentStrictSend. The full list is in CREDENTIALS.md.';

// What the credential lets the node sign. A control that is undefined has no limit.
export interface Policy {
	// Operation types, as the SDK names them.
	allowedOperations?: string[];
}

// A policy field that can't be read. It never repeats what was entered, only where it is: the
// field could hold a secret key pasted by mistake.
export interface PolicyProblem {
	// The field's name on the credential screen.
	field: string;
	// Completes "'Allowed Operations' …".
	problem: string;
	// How to fix it.
	fix: string;
}

export type PolicyReading = { policy: Policy } | { invalid: PolicyProblem };

// Reads the policy from the credential's fields. A field that can't be read makes the whole policy
// invalid: it never counts as "no limit".
export function readPolicy(credential: Record<string, unknown> | undefined): PolicyReading {
	const policy: Policy = {};

	const lines = linesOf(credential?.allowedOperations);
	if (lines === undefined) {
		return invalid(ALLOWED_OPERATIONS, 'is not text', HOW_TO_WRITE_OPERATIONS);
	}
	const allowedOperations: string[] = [];
	for (const { text, number } of lines) {
		const type = OPERATION_TYPES.find((name) => name.toLowerCase() === text.toLowerCase());
		if (type === undefined) {
			return invalid(
				ALLOWED_OPERATIONS,
				`has a line that isn't an operation type (line ${number})`,
				HOW_TO_WRITE_OPERATIONS,
			);
		}
		if (!allowedOperations.includes(type)) {
			allowedOperations.push(type);
		}
	}
	if (allowedOperations.length > 0) {
		policy.allowedOperations = allowedOperations;
	}

	return { policy };
}

// What a transaction has that the policy doesn't allow.
export interface PolicyViolation {
	message: string;
	description: string;
}

// Returns the first thing in the transaction that the policy doesn't allow. It checks every
// operation, whatever its source account: a signature counts for the whole transaction.
export function checkPolicy(policy: Policy, transaction: Transaction): PolicyViolation | undefined {
	const { allowedOperations } = policy;
	if (allowedOperations !== undefined) {
		const index = transaction.operations.findIndex(({ type }) => !allowedOperations.includes(type));
		if (index !== -1) {
			const { type } = transaction.operations[index];
			return {
				message: `'${ALLOWED_OPERATIONS}' doesn't include ${type}`,
				description: `Operation ${index + 1} of the transaction is ${type}. '${ALLOWED_OPERATIONS}' in the Stellar Wallet API credential has ${allowedOperations.join(', ')}. This item was not signed. Build the transaction without that operation, or add ${type} to '${ALLOWED_OPERATIONS}'.`,
			};
		}
	}
	return undefined;
}

function invalid(field: string, problem: string, fix: string): PolicyReading {
	return { invalid: { field, problem, fix } };
}

// The lines of a text field that have something, each with its number in the field. A field that
// was never saved counts as empty. Undefined when the value isn't text.
function linesOf(value: unknown): { text: string; number: number }[] | undefined {
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	// trim also removes the \r of a Windows line break.
	return value
		.split('\n')
		.map((line, index) => ({ text: line.trim(), number: index + 1 }))
		.filter(({ text }) => text !== '');
}
