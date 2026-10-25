import { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class ConfidentialTokenHolderApi implements ICredentialType {
	name = 'confidentialTokenHolderApi';
	displayName = 'Confidential Token Holder API';

	icon: Icon = {
		light: 'file:../nodes/StellarSigner/stellarLogo.svg',
		dark: 'file:../nodes/StellarSigner/stellarLogo.dark.svg',
	};

	documentationUrl =
		'https://github.com/elitelephant/n8n-nodes-stellar#confidential-token-holder-api';

	properties: INodeProperties[] = [
		// OpenZeppelin, sdk-spec/key-derivation.md v0.8.0 (copy in anexos/evidencia-confidential-token-25-10,
		// read on 25-10-2026): "The ed25519 key is a single point of failure, and this MUST be
		// disclosed". ADR 0102, rule 2.
		{
			displayName:
				"This key gives full access to the confidential account: whoever has it can see the balance and spend it. The account's confidentiality is only as safe as this key, and it can't be rotated: replacing it means registering a new account and moving the funds. Confidential Token works only on testnet.",
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Secret Key',
			name: 'secretKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			placeholder: 'e.g. SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
			description: 'The secret key of your Stellar account (starts with S)',
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
				'The highest amount of each asset that one confidential transfer or withdrawal may move, one per line, as XLM=100 or CODE:ISSUER=100, where ISSUER is the address of the account that issues the asset. XLM can also be written native. While any limit is set, a transfer or withdrawal of an asset without a line fails. Leave empty for no limits.',
		},
		{
			displayName: 'Allowed Destinations',
			name: 'allowedDestinations',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
			description:
				'The addresses this account may send to in a confidential transfer or a withdrawal, one per line. Leave empty to send to any address.',
		},
		{
			displayName: 'Maximum Fee',
			name: 'maxFee',
			type: 'number',
			typeOptions: {
				minValue: 0,
				numberPrecision: 0,
			},
			default: 0,
			description:
				"The highest fee that a transaction may carry, in stroops: 1 XLM is 10,000,000 stroops. It is the transaction's total fee, with its resource fee and the rent of the ledger entries it writes. 0 means no limit.",
		},
	];
}
