import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { extractBaseAddress, StrKey } from '@stellar/stellar-sdk';

import { fromStroops } from '../../../shared/amount';
import { findBalances, horizonFor } from '../../transport/horizon';
import { readNetwork } from '../common';
import { forEachItem } from '../forEachItem';

const showFor = { show: { resource: ['account'], operation: ['get'] } };

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
			'The account to read: a G address, or the M address of one of its users, which stands for its G account',
	},
];

// Reads each item's account from Horizon: its balance of each asset, what it can spend of each, the
// limit of each trustline, its minimum balance, its number of subentries and its sequence number.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const networkName = readNetwork(this, node, itemIndex);
		const horizon = horizonFor(
			node,
			networkName,
			this.getNodeParameter('horizonUrl', itemIndex, ''),
			itemIndex,
		);
		// An M address is a user of its G account, which is the one on the network.
		const accountId = extractBaseAddress(
			readAccount(node, this.getNodeParameter('account', itemIndex), itemIndex),
		);

		const { account, reserve, minimumBalance, balances } = await findBalances(
			node,
			horizon,
			accountId,
			networkName,
			itemIndex,
		);
		return {
			account: accountId,
			balances,
			minimumBalance: fromStroops(minimumBalance),
			baseReserve: fromStroops(reserve),
			subentryCount: account.subentry_count,
			sequence: account.sequence,
			networkName,
		};
	});
}

// The account to read, as a G address or as an M address of one of its users.
function readAccount(node: INode, value: unknown, itemIndex: number): string {
	if (
		typeof value !== 'string' ||
		!(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidMed25519PublicKey(value))
	) {
		throw new NodeOperationError(node, "'Account' isn't a valid Stellar address", {
			itemIndex,
			description:
				'Enter the address of the account: 56 characters starting with G, or 69 starting with M.',
		});
	}
	return value;
}
