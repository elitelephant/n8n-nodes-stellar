import type { IExecuteFunctions, INode, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { isNetworkName, type NetworkName } from '../../shared/network';

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
