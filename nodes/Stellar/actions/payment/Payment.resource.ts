import type { INodeProperties } from 'n8n-workflow';

import * as build from './build.operation';
import * as getTransaction from './getTransaction.operation';
import { fields as paymentFields } from './payment';

export const operations = { build, getTransaction };

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
		{
			name: 'Get Transaction',
			value: 'getTransaction',
			description: 'Get a payment transaction from Horizon by its hash',
			action: 'Get transaction',
		},
	],
	default: 'build',
};

// Each operation's own fields, shown after the network.
export const fields: INodeProperties[] = [...paymentFields, ...getTransaction.description];
