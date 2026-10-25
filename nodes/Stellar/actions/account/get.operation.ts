import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { extractBaseAddress, type Horizon, StrKey } from '@stellar/stellar-sdk';

import { fromStroops, toStroops } from '../../../shared/amount';
import { assetOfBalance } from '../../../shared/asset';
import { baseReserve, findAccount, horizonFor } from '../../transport/horizon';
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

		const account = await findAccount(
			node,
			horizon,
			accountId,
			"Couldn't read the account",
			itemIndex,
		);
		// The address goes in the description: n8n replaces a message that happens to contain one of
		// Node's error codes, and an address can.
		if (account === undefined) {
			throw new NodeOperationError(node, `The account doesn't exist on ${networkName}`, {
				itemIndex,
				description: `Horizon has no account ${accountId} on ${networkName}. Check 'Account' and 'Network'. An account exists only after another account creates it with XLM; on testnet, Friendbot can create it.`,
			});
		}
		const reserve = BigInt(await baseReserve(node, horizon, itemIndex));
		const minimumBalance = minimumBalanceOf(account, reserve);
		return {
			account: accountId,
			balances: balancesOf(account, minimumBalance),
			minimumBalance: fromStroops(minimumBalance),
			baseReserve: fromStroops(reserve),
			subentryCount: account.subentry_count,
			sequence: account.sequence,
			networkName,
		};
	});
}

// The XLM an account has to keep, in stroops, as Stellar's docs give it: two base reserves, one
// more for each subentry and each entry it sponsors for another account, and one less for each of
// its entries that another account sponsors.
function minimumBalanceOf(account: Horizon.AccountResponse, reserve: bigint): bigint {
	const entries = 2 + account.subentry_count + account.num_sponsoring - account.num_sponsored;
	return BigInt(entries) * reserve;
}

// One balance per asset, XLM first and then the trustlines in Horizon's order. Liquidity pool
// shares aren't listed. What the account can spend is its balance minus what its sell offers
// commit, and, for XLM, minus its minimum balance too. It is never below zero.
function balancesOf(account: Horizon.AccountResponse, minimumBalance: bigint): IDataObject[] {
	const balances: IDataObject[] = [];
	for (const line of account.balances) {
		const asset = assetOfBalance(line);
		if (asset === undefined || !('selling_liabilities' in line)) {
			continue;
		}
		const free = toStroops(line.balance) - toStroops(line.selling_liabilities);
		if (asset === 'XLM') {
			const spendable = spendableText(free - minimumBalance);
			balances.unshift({ asset, balance: line.balance, spendable, limit: null });
		} else if ('limit' in line) {
			const spendable = spendableText(free);
			balances.push({ asset, balance: line.balance, spendable, limit: line.limit });
		}
	}
	return balances;
}

// What is left to spend, never below zero, as Horizon writes an amount.
function spendableText(stroops: bigint): string {
	return fromStroops(stroops > BigInt(0) ? stroops : BigInt(0));
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
