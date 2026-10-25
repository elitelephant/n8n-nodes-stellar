import type { IDataObject, IExecuteFunctions, INode, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Asset, Memo, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

import { toAmount } from '../../../shared/amount';
import { NETWORK_PASSPHRASES } from '../../../shared/network';
import { baseFee, horizonFor, loadSourceAccount, timeboundsFor } from '../../transport/horizon';
import { readNetwork } from '../common';

const showFor = { show: { resource: ['payment'], operation: ['build'] } };

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
		description: 'The account that receives the payment',
	},
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 25.5',
		displayOptions: showFor,
		description: 'How much XLM to send, with up to 7 decimals',
	},
	{
		displayName: 'Memo',
		name: 'memo',
		type: 'string',
		default: '',
		placeholder: 'e.g. INV-1001',
		displayOptions: showFor,
		description: `A text memo of up to ${MEMO_TEXT_BYTES} bytes, such as the invoice number the receiver uses to match the payment. Leave empty for no memo.`,
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

// Builds one unsigned payment in XLM for the Stellar Signer.
export async function execute(
	this: IExecuteFunctions,
	node: INode,
	itemIndex: number,
): Promise<IDataObject> {
	const networkName = readNetwork(this, node, itemIndex);
	const horizon = horizonFor(
		node,
		networkName,
		this.getNodeParameter('horizonUrl', itemIndex, ''),
		itemIndex,
	);
	const sourceAccount = readSourceAccount(
		node,
		this.getNodeParameter('sourceAccount', itemIndex),
		itemIndex,
	);
	const destination = this.getNodeParameter('destination', itemIndex) as string;
	const amount = readAmount(node, this.getNodeParameter('amount', itemIndex), itemIndex);
	const memo = readMemo(node, this.getNodeParameter('memo', itemIndex, ''), itemIndex);
	const timeLimit = readTimeLimit(
		node,
		this.getNodeParameter('timeLimit', itemIndex, 300),
		itemIndex,
	);

	const account = await loadSourceAccount(node, horizon, sourceAccount, networkName, itemIndex);
	const fee = await baseFee(node, horizon, itemIndex);
	const timebounds = await timeboundsFor(node, horizon, timeLimit, itemIndex);

	const builder = new TransactionBuilder(account, {
		fee: String(fee),
		networkPassphrase: NETWORK_PASSPHRASES[networkName],
		timebounds,
	}).addOperation(Operation.payment({ destination, asset: Asset.native(), amount }));
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
	};
}

// The amount as the SDK takes it. It is checked before any request to Horizon.
function readAmount(node: INode, value: unknown, itemIndex: number): string {
	const amount = toAmount(value);
	if (amount === undefined) {
		throw new NodeOperationError(node, "'Amount' must be a positive number with up to 7 decimals", {
			itemIndex,
			description:
				'Enter how much XLM to send, for example 25 or 25.5. Stellar amounts have at most 7 digits after the decimal point.',
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
