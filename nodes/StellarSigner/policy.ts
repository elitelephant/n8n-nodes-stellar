import type { OperationType, Transaction } from '@stellar/stellar-sdk';

// The signing policy: the limits that the Stellar Wallet API credential puts on what the node
// signs. This module doesn't depend on n8n. It reads the credential's fields and checks a decoded
// transaction against them.

// The names of the policy fields on the credential screen, for the error texts.
const LABELS = {
	allowedOperations: 'Allowed Operations',
	allowMessageSigning: 'Allow Message Signing',
};

// The operation types, as the Stellar SDK names each operation of a decoded transaction. The type
// makes the build fail if an SDK update adds a type that isn't here.
const KNOWN_OPERATION_TYPES: Record<OperationType, true> = {
	createAccount: true,
	payment: true,
	pathPaymentStrictReceive: true,
	pathPaymentStrictSend: true,
	manageSellOffer: true,
	manageBuyOffer: true,
	createPassiveSellOffer: true,
	setOptions: true,
	changeTrust: true,
	allowTrust: true,
	accountMerge: true,
	inflation: true,
	manageData: true,
	bumpSequence: true,
	createClaimableBalance: true,
	claimClaimableBalance: true,
	beginSponsoringFutureReserves: true,
	endSponsoringFutureReserves: true,
	revokeAccountSponsorship: true,
	revokeTrustlineSponsorship: true,
	revokeOfferSponsorship: true,
	revokeDataSponsorship: true,
	revokeClaimableBalanceSponsorship: true,
	revokeLiquidityPoolSponsorship: true,
	revokeSignerSponsorship: true,
	clawback: true,
	clawbackClaimableBalance: true,
	setTrustLineFlags: true,
	liquidityPoolDeposit: true,
	liquidityPoolWithdraw: true,
	invokeHostFunction: true,
	extendFootprintTtl: true,
	restoreFootprint: true,
};
const OPERATION_TYPES = Object.keys(KNOWN_OPERATION_TYPES);

const HOW_TO_WRITE_OPERATIONS =
	"Write one operation type per line, with the names the Stellar SDK uses, such as payment, createAccount or pathPaymentStrictSend. The full list is in the credential's documentation.";

// What the credential lets the node sign. A limit that is undefined doesn't apply.
export interface Policy {
	// Operation types, as the SDK names them.
	allowedOperations?: string[];
	// Signing messages is off unless the credential turns it on.
	allowMessageSigning: boolean;
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
	// A switch that was never saved is off.
	const allowMessageSigning = credential?.allowMessageSigning ?? false;
	if (typeof allowMessageSigning !== 'boolean') {
		return {
			invalid: {
				field: LABELS.allowMessageSigning,
				problem: 'is not on or off',
				fix: 'Turn the switch on or off in the credential. If it comes from an expression, check that it gives true or false.',
			},
		};
	}
	const policy: Policy = { allowMessageSigning };

	const allowedOperations = readAllowedOperations(credential?.allowedOperations);
	if (!Array.isArray(allowedOperations)) {
		return { invalid: allowedOperations };
	}
	if (allowedOperations.length > 0) {
		policy.allowedOperations = allowedOperations;
	}

	return { policy };
}

// The operation types of the list, with the SDK's spelling and without repeats.
function readAllowedOperations(value: unknown): string[] | PolicyProblem {
	const field = LABELS.allowedOperations;
	const lines = linesOf(value);
	if (lines === undefined) {
		return { field, problem: 'is not text', fix: HOW_TO_WRITE_OPERATIONS };
	}
	const types: string[] = [];
	for (const { text, lineNumber } of lines) {
		const type = OPERATION_TYPES.find((name) => name.toLowerCase() === text.toLowerCase());
		if (type === undefined) {
			return {
				field,
				problem: `has a line that isn't an operation type (line ${lineNumber})`,
				fix: HOW_TO_WRITE_OPERATIONS,
			};
		}
		if (!types.includes(type)) {
			types.push(type);
		}
	}
	return types;
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
			const field = LABELS.allowedOperations;
			return {
				message: `'${field}' doesn't include ${type}`,
				description: `Operation ${index + 1} of the transaction is ${type}. '${field}' in the Stellar Wallet API credential lists ${allowedOperations.join(', ')}. This item was not signed. Build the transaction without that operation, or add ${type} to '${field}'.`,
			};
		}
	}
	return undefined;
}

// Says why the credential doesn't let the node sign a message, or nothing if it does.
export function checkMessageSigning(policy: Policy): PolicyViolation | undefined {
	if (policy.allowMessageSigning) {
		return undefined;
	}
	const field = LABELS.allowMessageSigning;
	return {
		message: `'${field}' is off in the Stellar Wallet API credential`,
		description: `Sign Message signs any text it receives with this wallet's key, and a signed text can prove control of the account to another service. Turn on '${field}' in the credential only if this workflow should do that. This item was not signed.`,
	};
}

// The lines of a text field that have something, each with its number in the field. A field that
// was never saved counts as empty. Undefined when the value isn't text.
function linesOf(value: unknown): { text: string; lineNumber: number }[] | undefined {
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	// trim also removes the \r of a Windows line break.
	return value
		.split('\n')
		.map((line, index) => ({ text: line.trim(), lineNumber: index + 1 }))
		.filter(({ text }) => text !== '');
}
