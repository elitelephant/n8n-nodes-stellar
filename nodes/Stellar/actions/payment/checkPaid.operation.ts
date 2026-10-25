import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { extractBaseAddress, StrKey } from '@stellar/stellar-sdk';

import { toStroops } from '../../../shared/amount';
import { assetName } from '../../../shared/asset';
import {
	findPayments,
	HORIZON_PAGE_SIZE,
	horizonFor,
	joinedTransaction,
	receivedTransfer,
} from '../../transport/horizon';
import { readNetwork } from '../common';
import { forEachItem } from '../forEachItem';
import { readAmount, readAsset, readDestination, readMemo, readSourceAccount } from './payment';

const showFor = { show: { resource: ['payment'], operation: ['checkPaid'] } };

export const description: INodeProperties[] = [
	{
		displayName: 'Destination',
		name: 'destination',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. GABC...',
		displayOptions: showFor,
		description:
			'The account that would have received the payment, such as the supplier: a G address, or the M address of one of its users. With an M address, only a payment to that same M address counts.',
	},
	{
		displayName: 'Memo',
		name: 'memo',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. INV-1001',
		displayOptions: showFor,
		description:
			"The memo the payment carries, such as the invoice number. A batch carries the ID of its run, not the invoices'.",
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
			'The asset of the payment: XLM or native for lumens, or CODE:ISSUER for another asset',
	},
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 25.5',
		displayOptions: showFor,
		description: 'The amount of the payment, with up to 7 decimals. Only the exact amount counts.',
	},
	{
		displayName: 'Source Account',
		name: 'sourceAccount',
		type: 'string',
		default: '',
		placeholder: 'e.g. GABC...',
		displayOptions: showFor,
		description:
			'Only payments from this account count. Leave empty for payments from any account.',
	},
	{
		displayName: 'Max Records',
		name: 'maxRecords',
		type: 'number',
		typeOptions: {
			minValue: 1,
			numberPrecision: 0,
		},
		default: 200,
		validateType: 'number',
		displayOptions: showFor,
		description:
			"How many of the destination's latest payment records to look through, from the newest. A payment older than that isn't found.",
	},
];

// Looks for an earlier payment of each item's invoice among the payments its destination received,
// from the newest, with their transactions joined to see the memo: one with the same memo, asset
// and amount, and the same source if one is given. Not finding it means it isn't among the payments
// looked through: the output says how far back the search went.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const networkName = readNetwork(this, node, itemIndex);
		const horizon = horizonFor(
			node,
			networkName,
			this.getNodeParameter('horizonUrl', itemIndex, ''),
			itemIndex,
		);
		const address = readDestination(
			node,
			this.getNodeParameter('destination', itemIndex),
			itemIndex,
		);
		// An M address is a user of its G account, which is the one Horizon lists payments for.
		const destination = extractBaseAddress(address);
		const toUser = StrKey.isValidMed25519PublicKey(address) ? address : undefined;
		const memo = readRequiredMemo(node, this.getNodeParameter('memo', itemIndex, ''), itemIndex);
		const asset = assetName(
			readAsset(node, this.getNodeParameter('asset', itemIndex, 'XLM'), itemIndex),
		);
		const amountInStroops = toStroops(
			readAmount(
				node,
				this.getNodeParameter('amount', itemIndex),
				itemIndex,
				'Enter the amount of the payment, for example 25 or 25.5.',
			),
		);
		const source = readOptionalSource(
			node,
			this.getNodeParameter('sourceAccount', itemIndex, ''),
			itemIndex,
		);
		const maxRecords = readMaxRecords(
			node,
			this.getNodeParameter('maxRecords', itemIndex, 200),
			itemIndex,
		);

		let searched = 0;
		let searchedUntil: string | null = null;
		let cursor: string | undefined;
		while (searched < maxRecords) {
			const limit = Math.min(HORIZON_PAGE_SIZE, maxRecords - searched);
			const page = await findPayments(
				node,
				horizon,
				destination,
				{ order: 'desc', limit, cursor },
				"Couldn't read the destination's payments",
				itemIndex,
			);
			// A destination that doesn't exist has received nothing.
			const records = page?.records ?? [];
			for (const record of records) {
				searched += 1;
				searchedUntil = record.created_at;
				const transfer = receivedTransfer(record, destination);
				const transaction = joinedTransaction(record);
				if (
					transfer !== undefined &&
					transaction.memo === memo &&
					transfer.asset === asset &&
					toStroops(transfer.amount) === amountInStroops &&
					(source === undefined || transfer.from === source) &&
					(toUser === undefined || (record as { to_muxed?: string }).to_muxed === toUser)
				) {
					return {
						paid: true,
						txHash: record.transaction_hash,
						ledger: transaction.ledger,
						createdAt: record.created_at,
						searchedUntil,
						networkName,
					};
				}
				cursor = record.paging_token;
			}
			if (records.length < limit) {
				break;
			}
		}
		return {
			paid: false,
			txHash: null,
			ledger: null,
			createdAt: null,
			searchedUntil,
			networkName,
		};
	});
}

// How many payments to look through: a whole number, 1 or more.
function readMaxRecords(node: INode, value: unknown, itemIndex: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new NodeOperationError(node, "'Max Records' must be a whole number, 1 or more", {
			itemIndex,
			description:
				"Enter how many of the destination's latest payments to look through, for example 200.",
		});
	}
	return value;
}

// The memo to look for: Check Paid finds a payment by it, so it can't be empty.
function readRequiredMemo(node: INode, value: unknown, itemIndex: number): string {
	const memo = readMemo(node, value, itemIndex);
	if (memo === undefined) {
		throw new NodeOperationError(node, "'Memo' is empty", {
			itemIndex,
			description:
				"Check Paid finds a payment by its memo, such as the invoice number in it. Enter the memo that the payment carries. A batch carries the ID of its run, not the invoices'.",
		});
	}
	return memo;
}

// The account that must have sent the payment, or undefined for any account. Spaces around it don't
// count.
function readOptionalSource(node: INode, value: unknown, itemIndex: number): string | undefined {
	if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
		return undefined;
	}
	return readSourceAccount(node, typeof value === 'string' ? value.trim() : value, itemIndex);
}
