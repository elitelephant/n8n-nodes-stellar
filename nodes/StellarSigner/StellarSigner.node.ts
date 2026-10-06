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
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';

const ENTER_SECRET_KEY = "Enter the account's secret key: 56 characters, starting with S.";
const ENTER_TRANSACTION_XDR = 'Enter the base64 XDR of the transaction to sign.';

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
		const secretKey = credentials.secretKey;

		// An empty secret key fails the whole run, before the items and without an item index. The
		// SDK rejects it like any secret key it can't use, so keypairFromSecret throws here.
		if (isBlank(secretKey)) {
			keypairFromSecret(this.getNode(), secretKey);
		}

		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const transactionXdr = this.getNodeParameter('xdr', itemIndex, '');
				const network = this.getNodeParameter('network', itemIndex, 'mainnet') as string;
				const isMainnet = network === 'mainnet';
				const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;
				// The SDK's network names (Networks.PUBLIC, Networks.TESTNET), in lowercase.
				const networkName = isMainnet ? 'public' : 'testnet';

				// An empty XDR fails before the secret key is read. The SDK rejects it too, so
				// parseTransaction throws here.
				if (isBlank(transactionXdr)) {
					parseTransaction(this.getNode(), transactionXdr, networkPassphrase, itemIndex);
				}

				const keypair = keypairFromSecret(this.getNode(), secretKey, itemIndex);
				const transaction = parseTransaction(
					this.getNode(),
					transactionXdr,
					networkPassphrase,
					itemIndex,
				);
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

// The item index is left out for an empty secret key, which is checked before the items.
function keypairFromSecret(node: INode, secretKey: unknown, itemIndex?: number): Keypair {
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
	// The SDK error, for an empty secret key and when no own check explains the problem.
	cause?: Error;
}

// Says what is wrong with a secret key the SDK rejected. These checks only choose the text: the
// SDK alone decides which secret keys are valid. Of the secret key, only its first character (G)
// and its length are mentioned.
function explainInvalidSecretKey(secretKey: unknown, sdkError: unknown): SecretKeyRejection {
	if (typeof secretKey !== 'string') {
		return { problem: 'is not text', fix: ENTER_SECRET_KEY };
	}
	if (isBlank(secretKey)) {
		// An empty secret key has nothing to leak, so the SDK error is the cause without the check
		// of the last case.
		const cause = sdkError instanceof Error ? sdkError : undefined;
		return { problem: 'is empty', fix: ENTER_SECRET_KEY, cause };
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
	transactionXdr: unknown,
	networkPassphrase: string,
	itemIndex: number,
): Transaction {
	try {
		// The SDK decides first, also when the value is empty or isn't text.
		return new Transaction(transactionXdr as string, networkPassphrase);
	} catch (error) {
		const { problem, fix } = explainInvalidTransactionXdr(transactionXdr);
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: `'Transaction XDR' ${problem}`,
			description: fix,
		});
	}
}

// Says what is wrong with a transaction XDR the SDK rejected. These checks only choose the text:
// the SDK alone decides which XDR is valid.
function explainInvalidTransactionXdr(transactionXdr: unknown): { problem: string; fix: string } {
	if (typeof transactionXdr !== 'string') {
		return {
			problem: 'is not text',
			fix: 'Enter the base64 XDR of the transaction as text. If it comes from an expression, check that it gives a string, not an object or a number.',
		};
	}
	if (isBlank(transactionXdr)) {
		return {
			problem: 'is empty',
			fix: `${ENTER_TRANSACTION_XDR} If it comes from an expression, check that the expression gives a value for this item.`,
		};
	}
	if (isFeeBumpEnvelope(transactionXdr)) {
		return {
			problem: 'is a fee bump transaction',
			fix: "This node doesn't sign fee bump transactions. Sign the inner transaction instead.",
		};
	}
	return { problem: "isn't a valid transaction envelope", fix: ENTER_TRANSACTION_XDR };
}

// Reads the envelope type like the SDK does in TransactionBuilder.fromXdr, only to choose the
// message. An XDR that doesn't decode isn't a fee bump.
function isFeeBumpEnvelope(transactionXdr: string): boolean {
	try {
		const envelope = xdr.TransactionEnvelope.fromXdr(transactionXdr, 'base64');
		return envelope.type === 'envelopeTypeTxFeeBump';
	} catch {
		return false;
	}
}

// Empty text, or text with only spaces or line breaks. A value that isn't text isn't blank.
function isBlank(value: unknown): boolean {
	return typeof value === 'string' && value.trim() === '';
}
