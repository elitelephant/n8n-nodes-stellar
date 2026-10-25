import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

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
import { checkReceiver, readAmount, readDestination, readMemo, readSourceAccount } from './payment';

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
	const memoRequired = await checkReceiver(
		node,
		horizon,
		destination,
		asset,
		memo,
		networkName,
		itemIndex,
	);
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
