import type { INodeProperties } from 'n8n-workflow';

import * as buildTrustline from './buildTrustline.operation';

export const operations = { buildTrustline };

// The asset operations, shown right after the resource.
export const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['asset'] } },
	options: [
		{
			name: 'Build Trustline',
			value: 'buildTrustline',
			description:
				"Build an unsigned change trust (changeTrust) for the Stellar Signer, so an account can hold an issued asset such as USDC. If the Signer's credential limits amounts, assets or destinations, it signs only payments: list changeTrust in its Allowed Operations, together with the payment types it should sign, such as payment.",
			action: 'Build trustline',
		},
	],
	default: 'buildTrustline',
};

// Each operation's own fields, shown after the network.
export const fields: INodeProperties[] = [...buildTrustline.description];
