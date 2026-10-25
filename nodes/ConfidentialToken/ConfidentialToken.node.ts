import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { Keypair } from '@stellar/stellar-sdk';

import { readPolicy } from '../shared/policy';
import { commonProperties } from './actions/common';
import * as holder from './actions/holder/Holder.resource';
import { router } from './actions/router';

export class ConfidentialToken implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Confidential Token',
		name: 'confidentialToken',
		icon: {
			light: 'file:../StellarSigner/stellarLogo.svg',
			dark: 'file:../StellarSigner/stellarLogo.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		// Stellar, https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens (Stellar
		// Raven, 25-10-2026): "Confidential Tokens let users keep token balances and transaction
		// amounts private while keeping the sender and receiver's addresses publicly visible onchain."
		description:
			'Keep token balances and amounts private on Stellar testnet with confidential tokens, while sender and receiver addresses stay public',
		defaults: {
			name: 'Confidential Token',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// The node holds a key that sees and spends: it is not a tool for an AI agent. n8n-workflow 2.x
		// types this as true or an object; n8n treats false like a missing property (as the Stellar
		// Signer does).
		usableAsTool: false as unknown as true,
		credentials: [
			{
				name: 'confidentialTokenHolderApi',
				required: true,
				testedBy: 'confidentialTokenHolderApiTest',
				displayOptions: { show: { resource: ['holder'] } },
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Holder',
						value: 'holder',
					},
				],
				default: 'holder',
			},
			holder.operation,
			...commonProperties,
			...holder.fields,
		],
	};

	methods = {
		credentialTest: {
			// Reads the secret key and the policy offline: the credential doesn't know the token, so the
			// account isn't looked up. The SDK's error isn't repeated, because it can carry what was
			// read, and neither is the value of a policy field. A policy that can't be read stops every
			// Transfer and Withdraw, so saving the credential warns, as the Stellar Signer's does.
			async confidentialTokenHolderApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				let keypair: Keypair;
				try {
					keypair = Keypair.fromSecret(credential.data?.secretKey as string);
				} catch {
					return {
						status: 'Error',
						message:
							"'Secret Key' isn't a valid Stellar secret key. Enter 56 characters starting with S.",
					};
				}
				const reading = readPolicy(credential.data);
				if ('invalid' in reading) {
					const { field, problem, fix } = reading.invalid;
					return { status: 'Error', message: `'${field}' ${problem}. ${fix}` };
				}
				return {
					status: 'OK',
					message: `Valid secret key for public key ${keypair.publicKey()}`,
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await router.call(this);
	}
}
