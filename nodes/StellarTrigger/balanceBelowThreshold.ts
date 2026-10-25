import type { INode, INodeExecutionData, INodeProperties, IPollFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { Horizon } from '@stellar/stellar-sdk';

import { toAmount, toStroops } from '../shared/amount';
import { assetName, toAsset } from '../shared/asset';
import type { NetworkName } from '../shared/network';
import { type Balance, findBalances } from '../Stellar/transport/horizon';
import { memoryFor } from './memory';

const showFor = { show: { event: ['balanceBelowThreshold'] } };

// Which of the account's balances of the asset to compare with the threshold, and its name in the
// texts.
type CompareWith = 'spendable' | 'balance';
const COMPARED = { spendable: 'spendable balance', balance: 'balance' };

export const balanceProperties: INodeProperties[] = [
	{
		displayName: 'Asset',
		name: 'asset',
		type: 'string',
		required: true,
		default: 'XLM',
		placeholder: 'e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
		displayOptions: showFor,
		description:
			"The asset whose balance to watch: XLM or native for lumens, or CODE:ISSUER for another asset. The account needs a trustline for an asset that isn't XLM.",
	},
	{
		displayName: 'Threshold',
		name: 'threshold',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 500',
		displayOptions: showFor,
		description: 'The trigger fires when the balance goes below this amount, with up to 7 decimals',
	},
	{
		displayName: 'Compare With',
		name: 'compareWith',
		type: 'options',
		options: [
			{
				name: 'Spendable Balance',
				value: 'spendable',
				description:
					'What the account can send: its balance minus what its sell offers commit, and, for XLM, minus the minimum balance it has to keep',
			},
			{
				name: 'Balance',
				value: 'balance',
				description: 'The whole balance of the asset, as Horizon gives it',
			},
		],
		default: 'spendable',
		displayOptions: showFor,
		description: 'Which balance of the asset to compare with the threshold',
	},
];

// Fires when the account's balance of the asset goes below the threshold: once, and again only
// after the balance gets back to the threshold. A first poll, or one after a parameter changed,
// fires if the balance is already below. A manual test has no memory, so it returns the balance
// whenever it is below.
export async function pollBalance(
	context: IPollFunctions,
	node: INode,
	horizon: Horizon.Server,
	account: string,
	networkName: NetworkName,
): Promise<INodeExecutionData[][] | null> {
	const asset = readAsset(node, context.getNodeParameter('asset', 'XLM'));
	const threshold = readThreshold(node, context.getNodeParameter('threshold', ''));
	const compareWith = readCompareWith(node, context.getNodeParameter('compareWith', 'spendable'));

	const balance = await balanceOf(node, horizon, account, asset, networkName);
	const below = toStroops(balance[compareWith]) < toStroops(threshold);
	const item = {
		account,
		asset,
		balance: balance.balance,
		spendable: balance.spendable,
		threshold,
		compareWith,
		networkName,
	};

	if (context.getMode() === 'manual') {
		if (below) {
			return [[{ json: item }]];
		}
		// The address and the asset go in the description: n8n replaces a message that happens to
		// contain one of Node's error codes, and an address or an asset code can.
		throw new NodeOperationError(node, 'The balance is not below the threshold', {
			description: `On ${networkName}, account ${account} has a ${COMPARED[compareWith]} of ${balance[compareWith]} ${asset}, and 'Threshold' is ${threshold}. Once the workflow is active, the trigger fires when it goes below. To test it now, enter a higher threshold.`,
		});
	}

	const memory = memoryFor(context, 'balanceBelowThreshold');
	// A threshold written another way, such as 50.0 for 50, is the same one.
	const watching = [networkName, account, asset, toStroops(threshold), compareWith].join(' ');
	const wasBelow = memory.lowBalance?.watching === watching && memory.lowBalance.below;
	memory.lowBalance = { watching, below };
	return below && !wasBelow ? [[{ json: item }]] : null;
}

// The account's balance of the asset now, with what it can spend of it, as Account › Get gives it.
async function balanceOf(
	node: INode,
	horizon: Horizon.Server,
	account: string,
	asset: string,
	networkName: NetworkName,
): Promise<Balance> {
	const { balances } = await findBalances(node, horizon, account, networkName, undefined);
	const balance = balances.find((line) => line.asset === asset);
	if (balance === undefined) {
		throw new NodeOperationError(node, 'The account has no trustline for this asset', {
			description: `Account ${account} on ${networkName} has no trustline for ${asset}, so it has no balance of it to watch. Check 'Asset', or add a trustline to it first.`,
		});
	}
	return balance;
}

// The asset to watch, as the policy writes it. Spaces around it don't count.
function readAsset(node: INode, value: unknown): string {
	const asset = toAsset(typeof value === 'string' ? value.trim() : value);
	if (asset === undefined) {
		throw new NodeOperationError(node, "'Asset' isn't a valid Stellar asset", {
			description:
				'Write XLM or native for lumens, or CODE:ISSUER for another asset: its code, a colon, and the address of the account that issues it.',
		});
	}
	return assetName(asset);
}

// The threshold as the user wrote it, once it is checked to be a positive amount.
function readThreshold(node: INode, value: unknown): string {
	const threshold = toAmount(typeof value === 'string' ? value.trim() : value);
	if (threshold === undefined) {
		throw new NodeOperationError(
			node,
			"'Threshold' must be a positive number with up to 7 decimals",
			{
				description:
					'Enter the amount below which the trigger fires, for example 500 or 0.5. Stellar amounts have at most 7 digits after the decimal point.',
			},
		);
	}
	return threshold;
}

function readCompareWith(node: INode, value: unknown): CompareWith {
	if (value === 'spendable' || value === 'balance') {
		return value;
	}
	throw new NodeOperationError(node, "'Compare With' must be spendable or balance", {
		description: 'Choose Spendable Balance or Balance in the Compare With parameter.',
	});
}
