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
			displayName: 'Allow Message Signing',
			name: 'allowMessageSigning',
			type: 'boolean',
			default: false,
			description:
				'Whether the Stellar Signer may sign messages (SEP-53) with this wallet. Leave it off unless a workflow needs it: a signed message can prove control of the account to another service.',
		},
	];
}
