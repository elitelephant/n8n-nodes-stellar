import { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class StellarWalletApi implements ICredentialType {
	name = 'stellarWalletApi';
	displayName = 'Stellar Wallet API';

	icon: Icon = {
		light: 'file:../nodes/StellarSigner/stellarLogo.svg',
		dark: 'file:../nodes/StellarSigner/stellarLogo.dark.svg',
	};

	documentationUrl = 'https://github.com/yripper/n8n-nodes-stellar/blob/master/CREDENTIALS.md';

	properties: INodeProperties[] = [
		{
			displayName: 'Secret Key',
			name: 'secretKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			placeholder: 'e.g. SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
			description: 'The secret key of your Stellar wallet (starts with S)',
		},
		{
			displayName: 'Allowed Operations',
			name: 'allowedOperations',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. payment',
			description:
				"The operation types this wallet may sign, one per line, such as payment or createAccount. Leave empty to sign any operation. A transaction with any other operation fails and isn't signed.",
		},
		{
			displayName: 'Maximum Amounts',
			name: 'maxAmounts',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. XLM=100',
			description:
				'The highest amount of each asset that one operation may send, one per line, as XLM=100 or CODE:ISSUER=100. An asset without a line has no limit. Leave empty for no limits.',
		},
		{
			displayName: 'Allowed Assets',
			name: 'allowedAssets',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. XLM',
			description:
				'The assets this wallet may pay in, one per line, as XLM or CODE:ISSUER. A path payment needs both the asset it sends and the asset it delivers. Leave empty to pay in any asset.',
		},
		{
			displayName: 'Allow Message Signing',
			name: 'allowMessageSigning',
			type: 'boolean',
			default: false,
			description:
				'Whether the Stellar Signer may sign messages (SEP-53) with this wallet. Leave it off unless a workflow needs it: a signed message can prove control of the account to another service.',
		},
	];
}
