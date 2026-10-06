import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IExecuteFunctions,
	INode,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';

const ENTER_SECRET_KEY = "Enter the account's secret key: 56 characters, starting with S.";

export class StellarSigner implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stellar Signer',
		name: 'stellarSigner',
		icon: { light: 'file:stellarLogo.svg', dark: 'file:stellarLogo.dark.svg' },
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
		// n8n-workflow 2.x types this as true or an object; n8n treats false like a missing property.
		usableAsTool: false as unknown as true,
		credentials: [
			{
				name: 'stellarWalletApi',
				required: true,
				testedBy: 'stellarWalletApiTest',
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

	methods = {
		credentialTest: {
			// Reads the secret key offline: the credential doesn't know the network, so the
			// account isn't looked up.
			async stellarWalletApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const secretKey = credential.data?.secretKey;
				try {
					// The SDK decides first, also when the value isn't text.
					const keypair = Keypair.fromSecret(secretKey as string);
					return {
						status: 'OK',
						message: `Valid secret key for public key ${keypair.publicKey()}`,
					};
				} catch (error) {
					const { problem, fix } = explainInvalidSecretKey(secretKey, error);
					return { status: 'Error', message: `'Secret Key' ${problem}. ${fix}` };
				}
			},
		},
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

				const keypair = keypairFromSecret(this.getNode(), credentials.secretKey, itemIndex);
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

function keypairFromSecret(node: INode, secretKey: unknown, itemIndex: number): Keypair {
	try {
		// The SDK decides first, also when the value isn't text.
		return Keypair.fromSecret(secretKey as string);
	} catch (error) {
		const { problem, fix, cause } = explainInvalidSecretKey(secretKey, error);
		const message = `'Secret Key' in the Stellar Wallet API credential ${problem}`;
		// Built from the text, the error's cause is n8n's copy of that text, so the SDK error is
		// only the cause when explainInvalidSecretKey returns it.
		throw new NodeOperationError(node, cause ?? message, { itemIndex, message, description: fix });
	}
}

interface SecretKeyRejection {
	// Completes "'Secret Key' …" without repeating the secret key.
	problem: string;
	// How to fix it.
	fix: string;
	// The SDK error, only when no own check explains the problem.
	cause?: Error;
}

// Says what is wrong with a secret key the SDK rejected. These checks only choose the text: the
// SDK alone decides which secret keys are valid. Of the secret key, only its first character (G)
// and its length are mentioned.
function explainInvalidSecretKey(secretKey: unknown, sdkError: unknown): SecretKeyRejection {
	if (typeof secretKey !== 'string') {
		return { problem: 'is not text', fix: ENTER_SECRET_KEY };
	}
	if (secretKey.trim() === '') {
		return { problem: 'is empty', fix: ENTER_SECRET_KEY };
	}
	if (secretKey !== secretKey.trim()) {
		return {
			problem: 'has spaces or line breaks at the start or end',
			fix: 'Remove the spaces or line breaks around the secret key.',
		};
	}
	if (secretKey.startsWith('G')) {
		return {
			problem: 'looks like a public key',
			fix: "Enter the account's secret key, which starts with S, not its public key, which starts with G.",
		};
	}
	if (!secretKey.startsWith('S')) {
		return {
			problem: "doesn't start with S",
			fix: 'A Stellar secret key starts with S and has 56 characters.',
		};
	}
	if (secretKey.length !== 56) {
		const characters = secretKey.length === 1 ? '1 character' : `${secretKey.length} characters`;
		return {
			problem: `has ${characters} instead of 56`,
			fix: 'Check that the whole secret key was copied: it has 56 characters and starts with S.',
		};
	}
	if (/[^A-Z2-7]/.test(secretKey)) {
		return {
			problem: "has characters a Stellar secret key doesn't use",
			fix: 'A Stellar secret key only uses capital letters A to Z and digits 2 to 7.',
		};
	}
	const fix = 'Copy the secret key again from your wallet.';
	// The SDK text is added only if it doesn't contain the secret key, which SDK 17.1.0 never does.
	if (sdkError instanceof Error && !sdkError.message.includes(secretKey)) {
		return {
			problem: `looks like a typo (Stellar SDK: ${sdkError.message})`,
			fix,
			cause: sdkError,
		};
	}
	return { problem: 'looks like a typo', fix };
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
