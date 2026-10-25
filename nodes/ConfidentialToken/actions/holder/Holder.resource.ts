import type { INodeProperties } from 'n8n-workflow';

import * as deposit from './deposit.operation';
import * as getBalance from './getBalance.operation';
import * as merge from './merge.operation';
import * as register from './register.operation';
import * as transfer from './transfer.operation';
import * as withdraw from './withdraw.operation';

export const operations = { register, deposit, merge, transfer, withdraw, getBalance };

// The holder operations, shown right after the resource.
export const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['holder'] } },
	options: [
		{
			name: 'Deposit',
			value: 'deposit',
			// Stellar, https://developers.stellar.org/meetings/2026/09/03 (Stellar Raven, 25-10-2026):
			// "Deposit — public XLM goes into the pool. Merge — the sender moves their pending balance into
			// their spendable balance."
			description:
				"Move an amount of the token's public asset from the account into its confidential balance. It arrives in the receiving balance; merge it to spend it.",
			action: 'Deposit into confidential balance',
		},
		{
			name: 'Get Balance',
			value: 'getBalance',
			description: "Get the account's decrypted spendable and receiving balances",
			action: 'Get confidential balance',
		},
		{
			name: 'Merge',
			value: 'merge',
			// Same source as Deposit.
			description: 'Move the received balance into the spendable balance',
			action: 'Merge received balance',
		},
		{
			name: 'Register',
			value: 'register',
			// Stellar, https://developers.stellar.org/meetings/2026/09/03 (Stellar Raven, 25-10-2026):
			// "Register — each address registers once per wrapper contract".
			description:
				'Register the account in a confidential token. Each account registers once per token.',
			action: 'Register account',
		},
		{
			name: 'Transfer',
			value: 'transfer',
			// Stellar, https://developers.stellar.org/meetings/2026/09/03 (Stellar Raven, 25-10-2026):
			// "Transfer — the sender confidentially moves part of their spendable balance into the
			// receiver's pending balance." and "Withdraw — the receiver exchanges part of their claim for
			// regular XLM back in their wallet."
			description:
				'Send a hidden amount from the confidential balance to another registered account',
			action: 'Transfer confidential amount',
		},
		{
			name: 'Withdraw',
			value: 'withdraw',
			// Same source as Transfer.
			description:
				"Move an amount from the confidential balance back to the account's public balance",
			action: 'Withdraw from confidential balance',
		},
	],
	default: 'register',
};

// Each operation's own fields, shown after the common ones.
export const fields: INodeProperties[] = [
	...register.description,
	...deposit.description,
	...merge.description,
	...transfer.description,
	...withdraw.description,
	...getBalance.description,
];
