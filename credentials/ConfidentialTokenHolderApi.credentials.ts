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
				"The highest amount of each asset that one confidential transfer or withdrawal may move, one per line, as XLM=100 or CODE:ISSUER=100, where ISSUER is the address of the account that issues the asset. It is compared with the token's public asset, and only Transfer and Withdraw check it. XLM can also be written native. While any limit is set, a transfer or withdrawal of an asset without a line fails. Leave empty for no limits.",
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
				'The G addresses this account may send a confidential transfer to, one per line. Muxed (M) addresses are not accepted, because Transfer sends only to G accounts. Only Transfer checks it: a Withdraw always goes to this same account. Leave empty to send to any address.',
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
				'The highest total fee that one Transfer or Withdraw may carry, in stroops: 1 XLM is 10,000,000 stroops. It adds up the fee of every transaction the item signs, which is the automatic merge, if the node makes one, and the transfer or withdrawal, each with its resource fee and the rent of the ledger entries it writes. Register, Deposit and a Merge you run yourself have no fee limit. 0 means no limit.',
		},
	];
}
