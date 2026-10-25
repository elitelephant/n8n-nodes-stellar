import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	type Asset,
	extractBaseAddress,
	type Horizon,
	Memo,
	Operation,
	StrKey,
	TransactionBuilder,
} from '@stellar/stellar-sdk';

import { toAmount } from '../../../shared/amount';
import { assetName, assetOfBalance, toAsset } from '../../../shared/asset';
import { NETWORK_PASSPHRASES, type NetworkName } from '../../../shared/network';
import { baseFee, findAccount, horizonFor, timeboundsFor } from '../../transport/horizon';
import { readNetwork } from '../common';
import { forEachItem } from '../forEachItem';

const showFor = { show: { resource: ['payment'], operation: ['build'] } };

// "1" in base64: the value of config.memo_required on an account that asks for a memo (SEP-29).
const ACCOUNT_REQUIRES_MEMO = 'MQ==';

// A text memo holds up to 28 bytes of UTF-8.
const MEMO_TEXT_BYTES = 28;

export const description: INodeProperties[] = [
	{
		displayName: 'Source Account',
		name: 'sourceAccount',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. GABC...',
		displayOptions: showFor,
		description:
			'The public key of the account that pays, starting with G. The transaction uses its next sequence number, and its key signs it in the Stellar Signer.',
	},
	{
		displayName: 'Destination',
		name: 'destination',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. GABC...',
		displayOptions: showFor,
		description:
			'The account that receives the payment: a G address, or the M address of one of its users. It has to exist on the network.',
	},
	{
		displayName: 'Asset',
		name: 'asset',
		type: 'string',
		required: true,
		default: 'XLM',
		placeholder: 'e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
		displayOptions: showFor,
		description:
			"The asset to send: XLM or native for lumens, or CODE:ISSUER for another asset. The destination needs a trustline for an asset that isn't XLM.",
	},
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 25.5',
		displayOptions: showFor,
		description: 'How much of the asset to send, with up to 7 decimals',
	},
	{
		displayName: 'Memo',
		name: 'memo',
		type: 'string',
		default: '',
		placeholder: 'e.g. INV-1001',
		displayOptions: showFor,
		description: `A text memo of up to ${MEMO_TEXT_BYTES} bytes, such as the invoice number the receiver uses to match the payment. Leave empty for no memo, unless the destination asks for one (SEP-29).`,
	},
	{
		displayName: 'Time Limit (Seconds)',
		name: 'timeLimit',
		type: 'number',
		typeOptions: {
			minValue: 1,
			numberPrecision: 0,
		},
		default: 300,
		validateType: 'number',
		displayOptions: showFor,
		description:
			"How long the network accepts the transaction after it is built. Sign and submit it before then, or build it again. The time comes from Horizon's clock.",
	},
];

// Builds one unsigned payment per item for the Stellar Signer, in XLM or in an issued asset. Each
// source account is read from Horizon once per run, and every payment from it takes the next
// sequence number, in the order of the items. So a run with one transaction per invoice gets in
// whole when the Signer submits them in that order. A payment that fails before it is built takes
// no number.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	const sourceAccounts: SourceAccounts = new Map();
	return await forEachItem(
		this,
		node,
		async (itemIndex) => await buildPayment(this, node, itemIndex, sourceAccounts),
	);
}

// The source accounts of the run, as the SDK keeps them, by network and address: building a
// transaction moves the account's sequence number on.
type SourceAccounts = Map<string, Horizon.AccountResponse>;

// The source account, read from Horizon the first time the run needs it. An account that doesn't
// exist on the network fails the item. The address goes in the description: n8n replaces a message
// that happens to contain one of Node's error codes, and an address can.
async function sourceAccountFor(
	node: INode,
	horizon: Horizon.Server,
	sourceAccounts: SourceAccounts,
	networkName: NetworkName,
	sourceAccount: string,
	itemIndex: number,
): Promise<Horizon.AccountResponse> {
	const key = `${networkName} ${sourceAccount}`;
	const known = sourceAccounts.get(key);
	if (known !== undefined) {
		return known;
	}
	const account = await findAccount(
		node,
		horizon,
		sourceAccount,
		"Couldn't read the source account",
		itemIndex,
	);
	if (account === undefined) {
		throw new NodeOperationError(node, `The source account doesn't exist on ${networkName}`, {
			itemIndex,
			description: `Horizon has no account ${sourceAccount} on ${networkName}, so nothing was built. Check 'Source Account' and 'Network'. An account exists only after another account creates it with XLM; on testnet, Friendbot can create it.`,
		});
	}
	sourceAccounts.set(key, account);
	return account;
}

async function buildPayment(
	context: IExecuteFunctions,
	node: INode,
	itemIndex: number,
	sourceAccounts: SourceAccounts,
): Promise<IDataObject> {
	const networkName = readNetwork(context, node, itemIndex);
	const horizon = horizonFor(
		node,
		networkName,
		context.getNodeParameter('horizonUrl', itemIndex, ''),
		itemIndex,
	);
	const sourceAccount = readSourceAccount(
		node,
		context.getNodeParameter('sourceAccount', itemIndex),
		itemIndex,
	);
	const destination = readDestination(
		node,
		context.getNodeParameter('destination', itemIndex),
		itemIndex,
	);
	const asset = readAsset(node, context.getNodeParameter('asset', itemIndex, 'XLM'), itemIndex);
	const amount = readAmount(node, context.getNodeParameter('amount', itemIndex), itemIndex);
	const memo = readMemo(node, context.getNodeParameter('memo', itemIndex, ''), itemIndex);
	const timeLimit = readTimeLimit(
		node,
		context.getNodeParameter('timeLimit', itemIndex, 300),
		itemIndex,
	);

	const account = await sourceAccountFor(
		node,
		horizon,
		sourceAccounts,
		networkName,
		sourceAccount,
		itemIndex,
	);
	// An M address is a user of its G account, which is the one on the network.
	const receiverId = extractBaseAddress(destination);
	const receiver = await findAccount(
		node,
		horizon,
		receiverId,
		"Couldn't read the destination account",
		itemIndex,
	);
	if (receiver === undefined) {
		throw new NodeOperationError(node, `The destination account doesn't exist on ${networkName}`, {
			itemIndex,
			description: `Horizon has no account ${receiverId} on ${networkName}, so nothing was built. A payment can't create an account: create it first with a create account operation that sends it XLM. Check 'Destination' and 'Network'.`,
		});
	}
	if (!canReceive(receiver, receiverId, asset)) {
		// The asset goes in the description: n8n replaces a message that happens to contain one of
		// Node's error codes, and an asset code such as EPERM is one.
		throw new NodeOperationError(node, 'The destination has no trustline for this asset', {
			itemIndex,
			description: `Account ${receiverId} on ${networkName} has no trustline for ${assetName(asset)}, so nothing was built. The network rejects a payment in an asset that the destination doesn't trust. Ask the receiver to add a trustline to this asset first.`,
		});
	}
	const memoRequired = requiresMemo(receiver, destination);
	if (memoRequired && memo === undefined) {
		throw new NodeOperationError(node, 'The destination requires a memo', {
			itemIndex,
			description: `Account ${destination} asks for a memo on every payment (SEP-29), and 'Memo' is empty, so nothing was built. Enter the memo that the receiver gave you, such as the reference of a deposit to an exchange.`,
		});
	}
	const fee = await baseFee(node, horizon, itemIndex);
	const timebounds = await timeboundsFor(node, horizon, timeLimit, itemIndex);

	const builder = new TransactionBuilder(account, {
		fee: String(fee),
		networkPassphrase: NETWORK_PASSPHRASES[networkName],
		timebounds,
	}).addOperation(Operation.payment({ destination, asset, amount }));
	if (memo !== undefined) {
		builder.addMemo(Memo.text(memo));
	}
	const transaction = builder.build();

	return {
		xdr: transaction.toXDR(),
		// The hash doesn't depend on the signatures, so it is the one the signed transaction has.
		txHash: Buffer.from(transaction.hash()).toString('hex'),
		sourceAccount,
		sequence: transaction.sequence,
		fee: transaction.fee,
		memo: memo ?? null,
		networkName,
		// Only an account that exists gets this far.
		destinationExists: true,
		memoRequired,
		// Only a destination that can receive the asset gets this far.
		hasTrustline: true,
	};
}

// The amount as the SDK takes it. It is checked before any request to Horizon.
function readAmount(node: INode, value: unknown, itemIndex: number): string {
	const amount = toAmount(value);
	if (amount === undefined) {
		throw new NodeOperationError(node, "'Amount' must be a positive number with up to 7 decimals", {
			itemIndex,
			description:
				'Enter how much of the asset to send, for example 25 or 25.5. Stellar amounts have at most 7 digits after the decimal point.',
		});
	}
	return amount;
}

// A text memo, or undefined for none: an empty value, or an expression that gives
// nothing. A number, such as an invoice number from a sheet, is used as its text.
function readMemo(node: INode, value: unknown, itemIndex: number): string | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	const memo = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
	if (typeof memo !== 'string') {
		throw new NodeOperationError(node, "'Memo' must be text", {
			itemIndex,
			description:
				'Enter the memo as text, such as the invoice number. If it comes from an expression, check that it gives a string or a number, not an object.',
		});
	}
	if (Buffer.byteLength(memo, 'utf8') > MEMO_TEXT_BYTES) {
		throw new NodeOperationError(node, `'Memo' is longer than ${MEMO_TEXT_BYTES} bytes`, {
			itemIndex,
			description: `A text memo holds up to ${MEMO_TEXT_BYTES} bytes: ${MEMO_TEXT_BYTES} letters and digits without accents, fewer with accents or other characters outside ASCII. Use a shorter text, such as the invoice number alone.`,
		});
	}
	return memo;
}

// The account that pays, as a G address: the one that has the sequence number.
function readSourceAccount(node: INode, value: unknown, itemIndex: number): string {
	if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
		throw new NodeOperationError(node, "'Source Account' isn't a valid Stellar public key", {
			itemIndex,
			description: 'Enter the public key of the account that pays: 56 characters, starting with G.',
		});
	}
	return value;
}

// A time limit of at least one whole second: without one, the network would take the transaction
// at any time.
function readTimeLimit(node: INode, value: unknown, itemIndex: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new NodeOperationError(
			node,
			"'Time Limit (Seconds)' must be a whole number of seconds, 1 or more",
			{
				itemIndex,
				description:
					'Enter how many seconds the network accepts the transaction after it is built, for example 300 for five minutes.',
			},
		);
	}
	return value;
}

// Whether a payment to this destination needs a memo, as SEP-29 says: its account has the data
// entry config.memo_required set to 1, which Horizon gives in base64. An M address already names
// the user of the account, so it needs none, and the SDK's own check skips it too.
function requiresMemo(receiver: Horizon.AccountResponse, destination: string): boolean {
	return (
		!StrKey.isValidMed25519PublicKey(destination) &&
		receiver.data_attr['config.memo_required'] === ACCOUNT_REQUIRES_MEMO
	);
}

// The account that receives the payment, as a G address or as an M address of one of its users.
function readDestination(node: INode, value: unknown, itemIndex: number): string {
	if (
		typeof value !== 'string' ||
		!(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidMed25519PublicKey(value))
	) {
		throw new NodeOperationError(node, "'Destination' isn't a valid Stellar address", {
			itemIndex,
			description:
				'Enter the address of the account that receives the payment: 56 characters starting with G, or 69 starting with M.',
		});
	}
	return value;
}

// The asset to send. It is checked before any request to Horizon. Spaces around it, as a sheet can
// leave, don't count, as in the Stellar Signer's policy.
function readAsset(node: INode, value: unknown, itemIndex: number): Asset {
	const asset = toAsset(typeof value === 'string' ? value.trim() : value);
	if (asset === undefined) {
		throw new NodeOperationError(node, "'Asset' isn't a valid Stellar asset", {
			itemIndex,
			description:
				'Write XLM or native for lumens, or CODE:ISSUER for another asset: its code, a colon, and the address of the account that issues it, for example USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.',
		});
	}
	return asset;
}

// Whether the destination account can receive the asset: lumens always, an issued asset only with a
// trustline for it, except for its issuer, which doesn't hold its own asset.
function canReceive(receiver: Horizon.AccountResponse, receiverId: string, asset: Asset): boolean {
	if (asset.isNative() || asset.getIssuer() === receiverId) {
		return true;
	}
	return receiver.balances.some((line) => assetOfBalance(line) === assetName(asset));
}
