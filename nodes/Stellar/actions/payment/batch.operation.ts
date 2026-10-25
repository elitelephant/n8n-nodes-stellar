import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { type Asset, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { NETWORK_PASSPHRASES } from '../../../shared/network';
import { baseFee, horizonFor, isRequestFailure, timeboundsFor } from '../../transport/horizon';
import { readAsset, readNetwork, readTimeLimit, sourceAccountFor } from '../common';
import { errorOfNode } from '../forEachItem';
import { checkReceiver, readAmount, readDestination, readMemo, readSourceAccount } from './payment';

// A Stellar transaction has at most 100 operations.
const MAX_OPERATIONS = 100;

// One payment of the batch, from one input item.
interface BatchPayment {
	destination: string;
	asset: Asset;
	amount: string;
}

// Builds one unsigned transaction with a payment for each input item, such as a payroll run, for the
// Stellar Signer. The source account, the memo and the time limit come from the first item. The
// transaction applies all its payments or none, so one item that can't go in builds nothing, and
// the error names every item that can't. The output is a single item, linked to every input item.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const pairedItem = items.map((_, itemIndex) => ({ item: itemIndex }));
	try {
		return [{ json: await buildBatch(this, node, items.length), pairedItem }];
	} catch (error) {
		const nodeError = errorOfNode(node, error);
		if (!this.continueOnFail()) {
			throw nodeError;
		}
		return [{ json: items[0]?.json ?? {}, error: nodeError, pairedItem }];
	}
}

async function buildBatch(
	context: IExecuteFunctions,
	node: INode,
	itemCount: number,
): Promise<IDataObject> {
	if (itemCount > MAX_OPERATIONS) {
		throw new NodeOperationError(
			node,
			`${itemCount} payments are more than a transaction can hold`,
			{
				description: `A Stellar transaction has at most ${MAX_OPERATIONS} operations, so nothing was built. Split the run into batches of up to ${MAX_OPERATIONS} items, each with its own memo.`,
			},
		);
	}
	const networkName = readNetwork(context, node, 0);
	const horizon = horizonFor(node, networkName, context.getNodeParameter('horizonUrl', 0, ''), 0);
	const sourceAccount = readSourceAccount(node, context.getNodeParameter('sourceAccount', 0), 0);
	const memo = readMemo(node, context.getNodeParameter('memo', 0, ''), 0);
	const timeLimit = readTimeLimit(node, context.getNodeParameter('timeLimit', 0, 300), 0);

	// Every item is checked, so that the error names all the ones that can't go in.
	const payments: BatchPayment[] = [];
	const problems: { itemIndex: number; text: string }[] = [];
	for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
		try {
			const payment = {
				destination: readDestination(
					node,
					context.getNodeParameter('destination', itemIndex),
					itemIndex,
				),
				asset: readAsset(node, context.getNodeParameter('asset', itemIndex, 'XLM'), itemIndex),
				amount: readAmount(node, context.getNodeParameter('amount', itemIndex), itemIndex),
			};
			await checkReceiver(
				node,
				horizon,
				payment.destination,
				payment.asset,
				memo,
				networkName,
				itemIndex,
			);
			payments.push(payment);
		} catch (error) {
			// Horizon not answering isn't a problem of the item: it stops the batch with its own text.
			if (isRequestFailure(error)) {
				throw errorOfNode(node, error, itemIndex);
			}
			problems.push({ itemIndex, text: problemText(error) });
		}
	}
	if (problems.length > 0) {
		const them = problems.length === 1 ? 'that item' : 'those items';
		const listed = problems.map(({ itemIndex, text }) => `Item ${itemIndex}: ${text}`).join(' ');
		throw new NodeOperationError(
			node,
			`${itemsText(problems.map(({ itemIndex }) => itemIndex))} can't go in the batch`,
			{
				description: `Nothing was built: a transaction applies all its payments or none. ${listed} Fix or remove ${them} and run the batch again.`,
			},
		);
	}

	// One transaction takes one sequence number, so the account is read once and not kept.
	const account = await sourceAccountFor(node, horizon, undefined, networkName, sourceAccount, 0);
	const fee = await baseFee(node, horizon, 0);
	const timebounds = await timeboundsFor(node, horizon, timeLimit, 0);
	// The fee is per operation: the transaction's total is the base fee times its payments.
	const builder = new TransactionBuilder(account, {
		fee: String(fee),
		networkPassphrase: NETWORK_PASSPHRASES[networkName],
		timebounds,
	});
	for (const payment of payments) {
		builder.addOperation(Operation.payment(payment));
	}
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
		paymentCount: payments.length,
		networkName,
	};
}

// "Item 2", "Items 0 and 3" or "Items 0, 1 and 3".
function itemsText(indices: number[]): string {
	if (indices.length === 1) {
		return `Item ${indices[0]}`;
	}
	return `Items ${indices.slice(0, -1).join(', ')} and ${indices[indices.length - 1]}`;
}

// What is wrong with an item: its message, and the description that says what to do.
function problemText(error: unknown): string {
	if (!(error instanceof NodeOperationError)) {
		return `${String(error)}.`;
	}
	return error.description ? `${error.message}. ${error.description}` : `${error.message}.`;
}
