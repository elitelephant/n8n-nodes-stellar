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
import { Horizon, Keypair, Transaction, xdr } from '@stellar/stellar-sdk';

import {
	horizonUrlFor,
	isNetworkName,
	NETWORK_PASSPHRASES,
	type NetworkName,
} from '../shared/network';

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
		subtitle: '={{ $parameter["network"] }}',
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
						name: 'Public',
						value: 'public',
					},
					{
						name: 'Testnet',
						value: 'testnet',
					},
				],
				default: 'testnet',
				description:
					"The Stellar network to sign for. Each input item must have the same value in its 'networkName' field.",
			},
			{
				displayName: 'Submit to Horizon',
				name: 'submit',
				type: 'boolean',
				default: false,
				validateType: 'boolean',
				description:
					"Whether to submit the signed transaction to the network through Horizon, using SDF's server for the chosen network unless 'Horizon URL' has another. On the public network, this moves real funds.",
			},
			{
				displayName: 'Horizon URL',
				name: 'horizonUrl',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://horizon.example.com',
				displayOptions: {
					show: {
						submit: [true],
					},
				},
				description:
					"The Horizon server to submit to, as an https address. Leave empty to use SDF's server for the network: horizon-testnet.stellar.org for testnet and horizon.stellar.org for public. Stellar's documentation no longer lists the public server, so enter your provider's address if it stops answering.",
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
				const item = items[itemIndex];
				const transactionXdr = this.getNodeParameter('xdr', itemIndex, '');
				const networkName = networkNameFrom(
					this.getNode(),
					this.getNodeParameter('network', itemIndex, 'testnet'),
					itemIndex,
				);
				const networkPassphrase = NETWORK_PASSPHRASES[networkName];
				// Checked after the Network parameter and before the XDR and the item's secret key
				// check. An empty secret key still fails the run before the items. n8n doesn't check
				// that an item has json, so it is read with ?. here.
				checkItemNetwork(this.getNode(), item.json?.networkName, networkName, itemIndex);

				// With Submit to Horizon on, the server is set up before the transaction is read or
				// signed, so a wrong setting fails the item unsigned. horizonUrl is only read then:
				// n8n doesn't hand over a parameter that is hidden.
				let horizon: Horizon.Server | undefined;
				if (this.getNodeParameter('submit', itemIndex, false) === true) {
					horizon = horizonServerFor(
						this.getNode(),
						networkName,
						this.getNodeParameter('horizonUrl', itemIndex, ''),
						itemIndex,
					);
				}

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

				// No retries: a transaction that Horizon doesn't confirm fails the item.
				if (horizon !== undefined) {
					const response = await horizon.submitTransaction(transaction);
					newItem.json.submitted = true;
					newItem.json.ledger = response.ledger;
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

// Any other value, such as the 0.1.1 value mainnet, fails instead of signing for a network the user
// didn't choose.
function networkNameFrom(node: INode, value: unknown, itemIndex: number): NetworkName {
	if (isNetworkName(value)) {
		return value;
	}
	throw new NodeOperationError(node, "'Network' must be public or testnet", {
		itemIndex,
		description: 'Choose public or testnet in the Network parameter.',
	});
}

const ENTER_HORIZON_URL =
	"Enter the address of a Horizon server, for example https://horizon-testnet.stellar.org, or leave the field empty to use SDF's server for the network.";

// The Horizon client for the item's submission. A Horizon URL that can't be used fails the item
// here. A value without text, such as an expression that gives nothing, counts as empty.
function horizonServerFor(
	node: INode,
	networkName: NetworkName,
	horizonUrl: unknown,
	itemIndex: number,
): Horizon.Server {
	const url = horizonUrlFor(networkName, String(horizonUrl ?? ''));
	let protocol: string;
	try {
		protocol = new URL(url).protocol;
	} catch (error) {
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: "'Horizon URL' isn't a valid URL",
			description: ENTER_HORIZON_URL,
		});
	}
	try {
		return new Horizon.Server(url);
	} catch (error) {
		// The SDK only connects over https. It has no other reason to refuse a URL today, but if it
		// finds one, the error still names the field.
		throw new NodeOperationError(node, error, {
			itemIndex,
			message:
				protocol === 'https:'
					? "'Horizon URL' can't be used"
					: "'Horizon URL' must start with https://",
			description:
				"This node only submits to a Horizon server over https. Enter an https address, or leave the field empty to use SDF's server for the network.",
		});
	}
}

// The network isn't stored in the transaction XDR, so the item has to say which network its
// transaction was built for, in networkName. A signature for the wrong network looks valid, and
// the network only rejects it on submission.
function checkItemNetwork(
	node: INode,
	itemNetworkName: unknown,
	nodeNetworkName: NetworkName,
	itemIndex: number,
): void {
	if (itemNetworkName === undefined || itemNetworkName === null || isBlank(itemNetworkName)) {
		throw new NodeOperationError(node, "'networkName' is missing from the input item", {
			itemIndex,
			description:
				"Add a 'networkName' field with public or testnet, the network the transaction was built for. An Edit Fields node before this one can add it, with 'Include Other Input Fields' turned on so the item keeps its other fields.",
		});
	}
	if (!isNetworkName(itemNetworkName)) {
		throw new NodeOperationError(node, "'networkName' must be public or testnet", {
			itemIndex,
			description:
				"Set 'networkName' in the input item to public or testnet, in lowercase and without spaces. It is the network the transaction was built for.",
		});
	}
	if (itemNetworkName !== nodeNetworkName) {
		// The node only knows what the item says: the label may be wrong, not the transaction.
		throw new NodeOperationError(
			node,
			`'networkName' is ${itemNetworkName} but 'Network' is ${nodeNetworkName}`,
			{
				itemIndex,
				description: `The input item says the transaction was built for ${itemNetworkName}, and this node signs for ${nodeNetworkName}. Choose ${itemNetworkName} in the 'Network' parameter, build the transaction for ${nodeNetworkName}, or fix 'networkName' in the input item if it is wrong.`,
			},
		);
	}
}

// The item index is left out for an empty secret key, which is checked before the items.
function keypairFromSecret(node: INode, secretKey: unknown, itemIndex?: number): Keypair {
	try {
		// The SDK decides first, also when the value isn't text.
		return Keypair.fromSecret(secretKey as string);
	} catch (error) {
		const { problem, fix } = explainInvalidSecretKey(secretKey, error);
		const message = `'Secret Key' in the Stellar Wallet API credential ${problem}`;
		// Without a safe SDK error, the error is built from the message, and n8n sets a copy of it
		// as the cause.
		const cause = sdkErrorSafeToKeep(secretKey, error);
		throw new NodeOperationError(node, cause ?? message, { itemIndex, message, description: fix });
	}
}

interface Rejection {
	// Completes "'Secret Key' …" or "'Transaction XDR' …" without repeating the value.
	problem: string;
	// How to fix it.
	fix: string;
}

// Says what is wrong with a secret key the SDK rejected. These checks only choose the text: the
// SDK alone decides which secret keys are valid. The messages only mention the secret key's first
// character and its length.
function explainInvalidSecretKey(secretKey: unknown, sdkError: unknown): Rejection {
	if (typeof secretKey !== 'string') {
		return { problem: 'is not text', fix: ENTER_SECRET_KEY };
	}
	if (isBlank(secretKey)) {
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
	// The SDK text is added only when the SDK error is safe to keep as the cause.
	const keptError = sdkErrorSafeToKeep(secretKey, sdkError);
	if (keptError !== undefined) {
		return { problem: `looks like a typo (Stellar SDK: ${keptError.message})`, fix };
	}
	return { problem: 'looks like a typo', fix };
}

// Returns the SDK error if its text doesn't contain the secret key. SDK 17.1.0 never puts the key
// in its errors. A value that isn't text is compared as text, and an object also as JSON. If a
// conversion fails, nothing is compared and the error is kept. A blank secret key skips the check.
// It has nothing to leak, and the check would almost always drop its error, because every text
// contains the empty text and almost every one contains a space.
function sdkErrorSafeToKeep(secretKey: unknown, sdkError: unknown): Error | undefined {
	if (!(sdkError instanceof Error)) {
		return undefined;
	}
	if (isBlank(secretKey)) {
		return sdkError;
	}
	try {
		const enteredAsText = [String(secretKey)];
		if (typeof secretKey === 'object' && secretKey !== null) {
			enteredAsText.push(JSON.stringify(secretKey));
		}
		return enteredAsText.some((text) => sdkError.message.includes(text)) ? undefined : sdkError;
	} catch {
		return sdkError;
	}
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
function explainInvalidTransactionXdr(transactionXdr: unknown): Rejection {
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
