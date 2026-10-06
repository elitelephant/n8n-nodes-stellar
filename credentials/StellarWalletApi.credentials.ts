import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class StellarWalletApi implements ICredentialType {
	name = 'stellarWalletApi';
	displayName = 'Stellar Wallet API';

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
	];
}
