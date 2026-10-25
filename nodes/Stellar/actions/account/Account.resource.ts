import type { INodeProperties } from 'n8n-workflow';

import * as get from './get.operation';

export const operations = { get };

// The account operations, shown right after the resource.
export const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['account'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			description: "Get an account's balances and trustlines, without liquidity pool shares",
			action: 'Get account',
		},
	],
	default: 'get',
};

// Each operation's own fields, shown after the network.
export const fields: INodeProperties[] = [...get.description];
