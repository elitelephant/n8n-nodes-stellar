import {
	Asset,
	type OperationRecord,
	type OperationType,
	type Transaction,
} from '@stellar/stellar-sdk';

// The signing policy: the limits that the Stellar Wallet API credential puts on what the node
// signs. This module doesn't depend on n8n. It reads the credential's fields and checks a decoded
// transaction against them.

// The names of the policy fields on the credential screen, for the error texts.
const LABELS = {
	allowedOperations: 'Allowed Operations',
	maxAmounts: 'Maximum Amounts',
	allowedAssets: 'Allowed Assets',
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

// The operations that pay someone. They are the only ones the limits on amounts can be checked
// against.
const PAYMENT_TYPES = [
	'payment',
	'pathPaymentStrictSend',
	'pathPaymentStrictReceive',
	'createAccount',
];

const HOW_TO_WRITE_OPERATIONS =
	"Write one operation type per line, with the names the Stellar SDK uses, such as payment, createAccount or pathPaymentStrictSend. The full list is in the credential's documentation.";
const HOW_TO_WRITE_AMOUNTS =
	'Write one limit per line, as the asset, an equals sign and the amount: XLM=100 for lumens, or CODE:ISSUER=100 for another asset, with up to 7 decimals.';
const HOW_TO_WRITE_ASSETS =
	'Write one asset per line: XLM for lumens, or CODE:ISSUER for another asset, with its code and the address of the account that issues it.';

const NOT_SIGNED = 'This item was not signed.';

// What the credential lets the node sign. A limit that is undefined doesn't apply.
export interface Policy {
	// Operation types, as the SDK names them.
	allowedOperations?: string[];
	// The most that one operation may send of each asset, in stroops. The key is the asset as the
	// policy writes it: XLM or CODE:ISSUER.
	maxAmounts?: Map<string, bigint>;
	// The assets a payment may use, written the same way.
	allowedAssets?: string[];
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

	const maxAmounts = readMaxAmounts(credential?.maxAmounts);
	if (!(maxAmounts instanceof Map)) {
		return { invalid: maxAmounts };
	}
	if (maxAmounts.size > 0) {
		policy.maxAmounts = maxAmounts;
	}

	const allowedAssets = readAllowedAssets(credential?.allowedAssets);
	if (!Array.isArray(allowedAssets)) {
		return { invalid: allowedAssets };
	}
	if (allowedAssets.length > 0) {
		policy.allowedAssets = allowedAssets;
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

// The limit of each asset, from lines such as XLM=100. An asset on two lines is a mistake: the
// node can't tell which limit was meant.
function readMaxAmounts(value: unknown): Map<string, bigint> | PolicyProblem {
	const field = LABELS.maxAmounts;
	const lines = linesOf(value);
	if (lines === undefined) {
		return { field, problem: 'is not text', fix: HOW_TO_WRITE_AMOUNTS };
	}
	const limits = new Map<string, bigint>();
	for (const { text, lineNumber } of lines) {
		const parts = text.split('=');
		const asset = parts.length === 2 ? readAsset(parts[0].trim()) : undefined;
		const limit = parts.length === 2 ? readAmount(parts[1].trim()) : undefined;
		if (asset === undefined || limit === undefined) {
			return {
				field,
				problem: `has a line that isn't an asset and an amount (line ${lineNumber})`,
				fix: HOW_TO_WRITE_AMOUNTS,
			};
		}
		if (limits.has(asset)) {
			return {
				field,
				problem: `has the same asset on two lines (line ${lineNumber})`,
				fix: HOW_TO_WRITE_AMOUNTS,
			};
		}
		limits.set(asset, limit);
	}
	return limits;
}

// The assets of the list, as the policy writes them.
function readAllowedAssets(value: unknown): string[] | PolicyProblem {
	const field = LABELS.allowedAssets;
	const lines = linesOf(value);
	if (lines === undefined) {
		return { field, problem: 'is not text', fix: HOW_TO_WRITE_ASSETS };
	}
	const assets: string[] = [];
	for (const { text, lineNumber } of lines) {
		const asset = readAsset(text);
		if (asset === undefined) {
			return {
				field,
				problem: `has a line that isn't an asset (line ${lineNumber})`,
				fix: HOW_TO_WRITE_ASSETS,
			};
		}
		assets.push(asset);
	}
	return assets;
}

// What a transaction has that the policy doesn't allow.
export interface PolicyViolation {
	message: string;
	description: string;
}

// Returns the first thing in the transaction that the policy doesn't allow. It checks every
// operation, whatever its source account: a signature counts for the whole transaction.
export function checkPolicy(policy: Policy, transaction: Transaction): PolicyViolation | undefined {
	for (let index = 0; index < transaction.operations.length; index++) {
		const violation = checkOperation(policy, transaction.operations[index], index + 1);
		if (violation !== undefined) {
			return violation;
		}
	}
	return undefined;
}

// Operations are counted from 1 in the error texts.
function checkOperation(
	policy: Policy,
	operation: OperationRecord,
	number: number,
): PolicyViolation | undefined {
	const { type } = operation;
	const credential = 'in the Stellar Wallet API credential';

	const { allowedOperations } = policy;
	if (allowedOperations !== undefined) {
		if (!allowedOperations.includes(type)) {
			const field = LABELS.allowedOperations;
			return {
				message: `'${field}' doesn't include ${type}`,
				description: `Operation ${number} of the transaction is ${type}. '${field}' ${credential} lists ${allowedOperations.join(', ')}. ${NOT_SIGNED} Build the transaction without that operation, or add ${type} to '${field}'.`,
			};
		}
	} else if (limitsPayments(policy) && !PAYMENT_TYPES.includes(type)) {
		// What can't be checked against the limits isn't signed, unless the credential names it.
		return {
			message: `This credential signs only payments, and operation ${number} is ${type}`,
			description: `The Stellar Wallet API credential has limits on amounts, destinations or assets, and only ${listOf(PAYMENT_TYPES)} operations can be checked against them. ${NOT_SIGNED} To sign ${type} with this credential, list it in '${LABELS.allowedOperations}' together with the payment types it should sign.`,
		};
	}

	const outflow = outflowOf(operation);
	if (outflow === undefined) {
		return undefined;
	}

	const { allowedAssets } = policy;
	if (allowedAssets !== undefined) {
		// A path payment changes asset on the way, so both ends have to be in the list.
		const ends: [Asset, string][] =
			outflow.delivered === undefined
				? [[outflow.asset, 'pays in']]
				: [
						[outflow.asset, 'sends'],
						[outflow.delivered, 'delivers'],
					];
		for (const [end, verb] of ends) {
			if (!allowedAssets.includes(assetKey(end))) {
				const field = LABELS.allowedAssets;
				return {
					message: `'${field}' doesn't include ${codeOf(end)}`,
					description: `Operation ${number} of the transaction (${type}) ${verb} ${assetKey(end)}, which isn't in '${field}' ${credential}. ${NOT_SIGNED} Pay in an asset of the list, or add that asset to '${field}'.`,
				};
			}
		}
	}

	const asset = assetKey(outflow.asset);
	const limit = policy.maxAmounts?.get(asset);
	if (limit !== undefined) {
		// An amount that can't be read counts as over the limit.
		const sent = readAmount(outflow.amount);
		if (sent === undefined || sent > limit) {
			const field = LABELS.maxAmounts;
			const code = codeOf(outflow.asset);
			const sends = outflow.isCeiling ? 'may send up to' : 'sends';
			const amount = sent === undefined ? outflow.amount : writeAmount(sent);
			return {
				message: `'${field}' allows up to ${writeAmount(limit)} ${code} per operation`,
				description: `Operation ${number} of the transaction (${type}) ${sends} ${amount} ${asset}. '${field}' ${credential} allows up to ${writeAmount(limit)} ${asset} per operation. ${NOT_SIGNED} Lower the amount, or raise the limit in the credential.`,
			};
		}
	}

	return undefined;
}

// Whether the policy has a limit that only payment operations can be checked against.
function limitsPayments(policy: Policy): boolean {
	return policy.maxAmounts !== undefined || policy.allowedAssets !== undefined;
}

// What a payment operation takes out of the account.
interface Outflow {
	// As the SDK gives it: a decimal with 7 digits.
	amount: string;
	asset: Asset;
	// True when the amount is the most the operation may send, not exactly what it sends.
	isCeiling: boolean;
	// For a path payment, the asset that reaches the destination.
	delivered?: Asset;
}

function outflowOf(operation: OperationRecord): Outflow | undefined {
	switch (operation.type) {
		case 'payment':
			return { amount: operation.amount, asset: operation.asset, isCeiling: false };
		case 'pathPaymentStrictSend':
			return {
				amount: operation.sendAmount,
				asset: operation.sendAsset,
				isCeiling: false,
				delivered: operation.destAsset,
			};
		case 'pathPaymentStrictReceive':
			return {
				amount: operation.sendMax,
				asset: operation.sendAsset,
				isCeiling: true,
				delivered: operation.destAsset,
			};
		case 'createAccount':
			return { amount: operation.startingBalance, asset: Asset.native(), isCeiling: false };
		default:
			return undefined;
	}
}

// Says why the credential doesn't let the node sign a message, or nothing if it does.
export function checkMessageSigning(policy: Policy): PolicyViolation | undefined {
	if (policy.allowMessageSigning) {
		return undefined;
	}
	const field = LABELS.allowMessageSigning;
	return {
		message: `'${field}' is off in the Stellar Wallet API credential`,
		description: `Sign Message signs any text it receives with this wallet's key, and a signed text can prove control of the account to another service. Turn on '${field}' in the credential only if this workflow should do that. ${NOT_SIGNED}`,
	};
}

// An asset as the policy writes it: XLM for the native asset and CODE:ISSUER for any other. An
// issued asset whose code is XLM is not the native one.
function assetKey(asset: Asset): string {
	return asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
}

// The asset's short name, for an error message. The issuer goes in the description.
function codeOf(asset: Asset): string {
	return asset.isNative() ? 'XLM' : asset.getCode();
}

// Reads XLM or CODE:ISSUER. The SDK decides which codes and issuers are valid. Undefined if the
// text is neither.
function readAsset(text: string): string | undefined {
	if (text.toUpperCase() === 'XLM') {
		return 'XLM';
	}
	const parts = text.split(':');
	if (parts.length !== 2) {
		return undefined;
	}
	try {
		return assetKey(new Asset(parts[0], parts[1]));
	} catch {
		return undefined;
	}
}

// Stellar amounts have 7 decimals and fit in 64 bits as stroops. They are handled as whole
// stroops, never as JS numbers, which lose digits.
const STROOPS_PER_UNIT = BigInt(10000000);
const MAX_STROOPS = BigInt('9223372036854775807');

// Reads an amount such as 100 or 50.5 as stroops. Undefined if the text isn't an amount.
function readAmount(text: string): bigint | undefined {
	const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text);
	if (match === null) {
		return undefined;
	}
	const stroops = BigInt(match[1]) * STROOPS_PER_UNIT + BigInt((match[2] ?? '').padEnd(7, '0'));
	return stroops > MAX_STROOPS ? undefined : stroops;
}

// Writes stroops as an amount without trailing zeros: 100, 50.5.
function writeAmount(stroops: bigint): string {
	const decimals = (stroops % STROOPS_PER_UNIT).toString().padStart(7, '0').replace(/0+$/, '');
	const units = (stroops / STROOPS_PER_UNIT).toString();
	return decimals === '' ? units : `${units}.${decimals}`;
}

// "a, b, c and d".
function listOf(names: string[]): string {
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
