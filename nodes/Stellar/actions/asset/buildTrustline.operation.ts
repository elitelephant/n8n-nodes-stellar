import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { type Asset, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

import { toAmount } from '../../../shared/amount';
import { assetName } from '../../../shared/asset';
import { NETWORK_PASSPHRASES } from '../../../shared/network';
import { baseFee, horizonFor, timeboundsFor } from '../../transport/horizon';
import {
	readAsset,
	readNetwork,
	readTimeLimit,
	type SourceAccounts,
	sourceAccountFor,
} from '../common';
import { forEachItem } from '../forEachItem';

const showFor = { show: { resource: ['asset'], operation: ['buildTrustline'] } };

export const description: INodeProperties[] = [
	{
		displayName: 'Account',
		name: 'account',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. GABC...',
		displayOptions: showFor,
		description:
			'The public key of the account that will hold the asset, starting with G. The transaction uses its next sequence number, and its key signs it in the Stellar Signer. Each new trustline raises the XLM the account has to keep by one base reserve.',
	},
	{
		displayName: 'Asset',
		name: 'asset',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
		displayOptions: showFor,
		description:
			'The asset to trust, as CODE:ISSUER: its code, a colon, and the address of the account that issues it. XLM needs no trustline.',
	},
	{
		displayName: 'Trust Limit',
		name: 'trustLimit',
		type: 'string',
		default: '',
		placeholder: 'e.g. 5000',
		displayOptions: showFor,
		description:
			'The most of the asset the account can hold, with up to 7 decimals. Leave empty for the largest amount Stellar allows. If the account already trusts the asset, the transaction sets its limit to this one, or to the largest when empty.',
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

// Builds one unsigned change trust per item for the Stellar Signer, so the account can hold an
// issued asset. As in Payment › Build, each account is read from Horizon once per run, and every
// transaction from it takes the next sequence number, in the order of the items.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	const sourceAccounts: SourceAccounts = new Map();
	return await forEachItem(
		this,
		node,
		async (itemIndex) => await buildTrustline(this, node, itemIndex, sourceAccounts),
	);
}

async function buildTrustline(
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
	const accountId = readTrustingAccount(
		node,
		context.getNodeParameter('account', itemIndex),
		itemIndex,
	);
	const asset = readIssuedAsset(node, context.getNodeParameter('asset', itemIndex), itemIndex);
	const limit = readTrustLimit(
		node,
		context.getNodeParameter('trustLimit', itemIndex, ''),
		itemIndex,
	);
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
		accountId,
		itemIndex,
		'Account',
	);
	const fee = await baseFee(node, horizon, itemIndex);
	const timebounds = await timeboundsFor(node, horizon, timeLimit, itemIndex);

	const transaction = new TransactionBuilder(account, {
		fee: String(fee),
		networkPassphrase: NETWORK_PASSPHRASES[networkName],
		timebounds,
	})
		.addOperation(Operation.changeTrust({ asset, limit }))
		.build();
	// The limit the trustline gets, as Horizon writes it: without one, the SDK sets the largest.
	const [changeTrust] = transaction.operations as Operation.ChangeTrust[];

	return {
		xdr: transaction.toXDR(),
		// The hash doesn't depend on the signatures, so it is the one the signed transaction has.
		txHash: Buffer.from(transaction.hash()).toString('hex'),
		sourceAccount: accountId,
		sequence: transaction.sequence,
		fee: transaction.fee,
		asset: assetName(asset),
		limit: changeTrust.limit,
		networkName,
	};
}

// The account that adds the trustline, as a G address: the one that has the sequence number.
function readTrustingAccount(node: INode, value: unknown, itemIndex: number): string {
	if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
		throw new NodeOperationError(node, "'Account' isn't a valid Stellar public key", {
			itemIndex,
			description:
				'Enter the public key of the account that will hold the asset: 56 characters, starting with G.',
		});
	}
	return value;
}

// An asset that needs a trustline: any but XLM, which every account holds.
function readIssuedAsset(node: INode, value: unknown, itemIndex: number): Asset {
	const asset = readAsset(node, value, itemIndex);
	if (asset.isNative()) {
		throw new NodeOperationError(node, "'Asset' must be an issued asset", {
			itemIndex,
			description:
				'Every account holds XLM without a trustline. Enter the asset to trust as CODE:ISSUER, for example USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.',
		});
	}
	return asset;
}

// The limit as the SDK takes it, or undefined for the largest one. A limit of 0 would remove the
// trustline, which this operation doesn't do.
function readTrustLimit(node: INode, value: unknown, itemIndex: number): string | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	const limit = toAmount(value);
	if (limit === undefined) {
		throw new NodeOperationError(
			node,
			"'Trust Limit' must be a positive number with up to 7 decimals",
			{
				itemIndex,
				description:
					'Enter the most of the asset the account can hold, for example 5000, or leave it empty for the largest amount Stellar allows. Stellar amounts have at most 7 digits after the decimal point.',
			},
		);
	}
	return limit;
}
