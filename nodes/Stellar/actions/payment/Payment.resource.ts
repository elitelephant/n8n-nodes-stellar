import type { INodeProperties } from 'n8n-workflow';

import * as build from './build.operation';

export const operations = { build };

// The payment operations, shown right after the resource.
export const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['payment'] } },
	options: [
		{
			name: 'Build',
			value: 'build',
			description: 'Build an unsigned payment for the Stellar Signer',
			action: 'Build payment',
		},
	],
	default: 'build',
};

// Each operation's own fields, shown after the network.
export const fields: INodeProperties[] = [...build.description];
