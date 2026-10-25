import type { IExecuteFunctions, INode, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { Asset, Horizon } from '@stellar/stellar-sdk';

import { toAsset } from '../../shared/asset';
import { isNetworkName, type NetworkName } from '../../shared/network';
import { findAccount } from '../transport/horizon';

// The parameters that every resource and operation of the node shares. The network values and
// names are the Stellar Signer's, so an item built here goes into it with its networkName.
export const commonProperties: INodeProperties[] = [
	{
		displayName: 'Network',
		name: 'network',
		type: 'options',
		options: [
			{
				name: 'Public',
				value: 'public',
			},
			{
				name: 'Testnet',
				value: 'testnet',
			},
		],
		default: 'public',
		description:
			"The Stellar network to read from and build for. Each output item has it in its 'networkName' field, which the Stellar Signer checks.",
	},
	{
		displayName: 'Horizon URL',
		name: 'horizonUrl',
		type: 'string',
		default: '',
		placeholder: 'e.g. https://horizon.example.com',
		description:
			"The Horizon server to read from, as an https address. Plain http works only for localhost, and the address can't have a user name or a password. Leave empty to use SDF's server for the network: horizon-testnet.stellar.org for testnet and horizon.stellar.org for public.",
	},
];

// The item's network. Any other value fails instead of building for a network the user didn't
// choose.
export function readNetwork(
	context: IExecuteFunctions,
	node: INode,
	itemIndex: number,
): NetworkName {
	const value = context.getNodeParameter('network', itemIndex, 'public');
	if (isNetworkName(value)) {
		return value;
	}
	throw new NodeOperationError(node, "'Network' must be public or testnet", {
		itemIndex,
		description: 'Choose public or testnet in the Network parameter.',
	});
}

// The source accounts of the run, as the SDK keeps them, by network and address: building a
// transaction moves the account's sequence number on.
export type SourceAccounts = Map<string, Horizon.AccountResponse>;

// The source account, read from Horizon the first time the run needs it, or every time without
// sourceAccounts. An account that doesn't exist on the network fails the item. The address goes in
// the description: n8n replaces a message that happens to contain one of Node's error codes, and an
// address can. field is the parameter that holds the account, for the error text.
export async function sourceAccountFor(
	node: INode,
	horizon: Horizon.Server,
	sourceAccounts: SourceAccounts | undefined,
	networkName: NetworkName,
	sourceAccount: string,
	itemIndex: number,
	field = 'Source Account',
): Promise<Horizon.AccountResponse> {
	const key = `${networkName} ${sourceAccount}`;
	const known = sourceAccounts?.get(key);
	if (known !== undefined) {
		return known;
	}
	const account = await findAccount(
		node,
		horizon,
		sourceAccount,
		`Couldn't read the ${field.toLowerCase()}`,
		itemIndex,
	);
	if (account === undefined) {
		throw new NodeOperationError(
			node,
			`The ${field.toLowerCase()} doesn't exist on ${networkName}`,
			{
				itemIndex,
				description: `Horizon has no account ${sourceAccount} on ${networkName}, so nothing was built. Check '${field}' and 'Network'. An account exists only after another account creates it with XLM; on testnet, Friendbot can create it.`,
			},
		);
	}
	sourceAccounts?.set(key, account);
	return account;
}

// The asset of an item, such as the one a payment sends. It is checked before any request to
// Horizon. Spaces around it, as a sheet can leave, don't count, as in the Stellar Signer's policy.
export function readAsset(node: INode, value: unknown, itemIndex: number): Asset {
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

// A time limit of at least one whole second: without one, the network would take the transaction
// at any time.
export function readTimeLimit(node: INode, value: unknown, itemIndex: number): number {
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
