import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { findTransaction, horizonFor } from '../../transport/horizon';
import { readNetwork } from '../common';
import { forEachItem } from '../forEachItem';

const showFor = { show: { resource: ['payment'], operation: ['getTransaction'] } };

// A transaction hash: 32 bytes in hexadecimal.
const TRANSACTION_HASH = /^[0-9a-f]{64}$/;

export const description: INodeProperties[] = [
	{
		displayName: 'Transaction Hash',
		name: 'txHash',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889',
		displayOptions: showFor,
		description:
			"The transaction's hash, 64 hexadecimal characters, such as the 'txHash' field of the Stellar Signer's output",
	},
];

// Looks each item's transaction up on Horizon by its hash: whether it was applied successfully, in
// which ledger and when, with its memo, the fee the network charged and its source account.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const networkName = readNetwork(this, node, itemIndex);
		const horizon = horizonFor(
			node,
			networkName,
			this.getNodeParameter('horizonUrl', itemIndex, ''),
			itemIndex,
		);
		const txHash = readTransactionHash(node, this.getNodeParameter('txHash', itemIndex), itemIndex);

		const record = await findTransaction(
			node,
			horizon,
			txHash,
			"Couldn't read the transaction",
			itemIndex,
		);
		if (record === undefined) {
			// A Horizon server keeps only the history its operator chose.
			throw new NodeOperationError(node, "Horizon doesn't have this transaction", {
				itemIndex,
				description: `Horizon at ${horizon.serverURL.host} has no transaction ${txHash} on ${networkName}. That doesn't prove it wasn't applied: a Horizon server keeps only part of the history, and one with ingestion filters keeps only some transactions. Check the hash and 'Network', or look it up on a Horizon server that keeps more history.`,
			});
		}
		return {
			txHash,
			successful: record.successful,
			// The SDK moves the ledger of a record it fetched to ledger_attr.
			ledger: record.ledger_attr,
			createdAt: record.created_at,
			memo: record.memo_type === 'none' ? null : (record.memo ?? null),
			feeCharged: String(record.fee_charged),
			sourceAccount: record.source_account,
			networkName,
		};
	});
}

// The hash in lowercase, as Horizon writes it. It is checked before any request to Horizon.
function readTransactionHash(node: INode, value: unknown, itemIndex: number): string {
	const txHash = typeof value === 'string' ? value.toLowerCase() : undefined;
	if (txHash === undefined || !TRANSACTION_HASH.test(txHash)) {
		throw new NodeOperationError(node, "'Transaction Hash' isn't a valid transaction hash", {
			itemIndex,
			description:
				"Enter the transaction's hash: 64 hexadecimal characters, such as the 'txHash' field of the Stellar Signer's output.",
		});
	}
	return txHash;
}
