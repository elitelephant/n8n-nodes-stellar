import type { INodeProperties } from 'n8n-workflow';

import * as batch from './batch.operation';
import * as build from './build.operation';
import * as checkPaid from './checkPaid.operation';
import * as getTransaction from './getTransaction.operation';
import { fields as paymentFields } from './payment';

export const operations = { batch, build, checkPaid, getTransaction };

// The payment operations, shown right after the resource.
export const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['payment'] } },
	options: [
		{
			name: 'Batch',
			value: 'batch',
			description:
				'Build one unsigned transaction with a payment for each input item, such as a payroll run. The source account, the memo and the time limit come from the first item.',
			action: 'Build payment batch',
		},
		{
			name: 'Build',
			value: 'build',
			description: 'Build an unsigned payment for the Stellar Signer',
			action: 'Build payment',
		},
		{
			name: 'Check Paid',
			value: 'checkPaid',
			description:
				'Check whether a payment with this memo, asset and amount already reached the destination',
			action: 'Check payment',
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
export const fields: INodeProperties[] = [
	...paymentFields,
	...checkPaid.description,
	...getTransaction.description,
];
