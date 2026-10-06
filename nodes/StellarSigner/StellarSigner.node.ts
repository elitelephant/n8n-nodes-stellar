import type {
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';

export class StellarSigner implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stellar Signer',
		name: 'stellarSigner',
		icon: { light: 'file:stellarLogo.svg', dark: 'file:stellarLogo.svg' },
		group: ['transform'],
		version: 1,
		// The same value as the networkName output field.
		subtitle: '={{ $parameter["network"] === "mainnet" ? "public" : "testnet" }}',
		description: 'Sign Stellar transactions using a wallet secret key',
		defaults: {
			name: 'Stellar Signer',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'stellarWalletApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Transaction XDR',
				name: 'xdr',
				type: 'string',
				default: '',
				placeholder: 'AAAAAgAAAAC...',
				description: 'The unsigned transaction XDR to sign',
			},
			{
				displayName: 'Network',
				name: 'network',
				type: 'options',
				options: [
					{
						name: 'Mainnet',
						value: 'mainnet',
					},
					{
						name: 'Testnet',
						value: 'testnet',
					},
				],
				default: 'mainnet',
				description: 'The Stellar network to use',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = await this.getCredentials('stellarWalletApi');

		if (!credentials || !credentials.secretKey) {
			throw new NodeOperationError(this.getNode(), 'Stellar wallet credentials are required');
		}

		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const xdr = this.getNodeParameter('xdr', itemIndex, '') as string;
				const network = this.getNodeParameter('network', itemIndex, 'mainnet') as string;

				if (!xdr) {
					throw new NodeOperationError(this.getNode(), 'Transaction XDR is required', {
						itemIndex,
					});
				}

				const keypair = keypairFromSecret(
					this.getNode(),
					credentials.secretKey as string,
					itemIndex,
				);
				const isMainnet = network === 'mainnet';
				const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;
				// The SDK's network names (Networks.PUBLIC, Networks.TESTNET), in lowercase.
				const networkName = isMainnet ? 'public' : 'testnet';

				const transaction = parseTransaction(this.getNode(), xdr, networkPassphrase, itemIndex);
				transaction.sign(keypair);

				const txHash = Buffer.from(transaction.hash()).toString('hex');
				const signedXdr = transaction.toXdr();

				const item = items[itemIndex];
				const newItem: INodeExecutionData = {
					json: {
						...item.json,
						signedXdr,
						txHash,
						publicKey: keypair.publicKey(),
						network: networkPassphrase,
						networkName,
					},
					pairedItem: itemIndex,
				};
				if (item.binary !== undefined) {
					newItem.binary = item.binary;
				}

				returnData.push(newItem);
			} catch (error) {
				// A NodeOperationError passes through unchanged and keeps its own itemIndex.
				const nodeError = new NodeOperationError(this.getNode(), error, { itemIndex });
				if (this.continueOnFail()) {
					returnData.push({
						json: items[itemIndex].json,
						error: nodeError,
						pairedItem: itemIndex,
					});
				} else {
					throw nodeError;
				}
			}
		}

		return [returnData];
	}
}

function keypairFromSecret(node: INode, secretKey: string, itemIndex: number): Keypair {
	try {
		return Keypair.fromSecret(secretKey);
	} catch {
		// The SDK error is left out so that nothing about the secret can reach the message.
		throw new NodeOperationError(node, 'Invalid secret key in the Stellar Wallet API credential', {
			itemIndex,
			description:
				"Check the credential's 'Secret Key': a Stellar secret key has 56 characters and starts with S.",
		});
	}
}

function parseTransaction(
	node: INode,
	xdr: string,
	networkPassphrase: string,
	itemIndex: number,
): Transaction {
	try {
		return new Transaction(xdr, networkPassphrase);
	} catch (error) {
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: 'Invalid or unsupported transaction XDR',
			description:
				"'Transaction XDR' must be a base64 transaction envelope. Fee bump transactions are not supported.",
		});
	}
}
