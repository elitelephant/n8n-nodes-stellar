import type { INodeProperties } from 'n8n-workflow';

import * as register from './register.operation';

export const operations = { register };

// The holder operations, shown right after the resource.
export const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['holder'] } },
	options: [
		{
			name: 'Register',
			value: 'register',
			// Stellar, https://developers.stellar.org/meetings/2026/09/03 (Stellar Raven, 25-10-2026):
			// "Register — each address registers once per wrapper contract".
			description:
				'Register the account in a confidential token. Each account registers once per token.',
			action: 'Register account',
		},
	],
	default: 'register',
};

// Each operation's own fields, shown after the common ones.
export const fields: INodeProperties[] = [...register.description];
