import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { StrKey } from '@stellar/stellar-sdk';

import { humanizeContractError } from '../../../vendor/stellar-confidential-token-sdk/src';
import { errorOfNode } from '../../Stellar/actions/forEachItem';

export const NETWORK_NAME = 'testnet';

// Where the node keeps each account's state and the CRS when State Folder is empty. It sits in the
// folder n8n itself uses for its data.
export function defaultStateFolder(): string {
	return join(homedir(), '.n8n', 'stellar-confidential');
}

const showFor = { show: { resource: ['holder'] } };

// The parameters that every operation of the node shares. The network name is the Stellar Signer's,
// so an item that comes out of here can be checked against it.
export const commonProperties: INodeProperties[] = [
	{
		displayName: 'Network',
		name: 'network',
		type: 'options',
		options: [
			{
				name: 'Testnet',
				value: 'testnet',
			},
		],
		default: 'testnet',
		displayOptions: showFor,
		// Stellar, https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens (Stellar
		// Raven, 25-10-2026): "The current verifier accepts only non-zero-knowledge UltraHonk proofs, so
		// OpenZeppelin does not guarantee that proofs keep balances and amounts private."
		description:
			"Confidential Token works only on testnet. Its verifier accepts only non-zero-knowledge proofs, so OpenZeppelin doesn't guarantee yet that balances and amounts stay private.",
	},
	{
		displayName: 'RPC URL',
		name: 'rpcUrl',
		type: 'string',
		default: '',
		placeholder: 'e.g. https://rpc.example.com',
		displayOptions: showFor,
		description:
			"The Stellar RPC server to read from and send to, as an https address. Plain http works only for localhost, and the address can't have a user name or a password. Leave empty to use SDF's server: soroban-testnet.stellar.org.",
	},
	{
		displayName: 'Token Contract',
		name: 'confidentialContract',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. CABC...',
		displayOptions: showFor,
		description: 'The address of the confidential token contract, starting with C',
	},
	{
		displayName: 'Verifier Contract',
		name: 'verifierContract',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. CABC...',
		displayOptions: showFor,
		description:
			"The address of the verifier contract that checks this token's proofs, starting with C",
	},
	{
		displayName: 'Auditor Contract',
		name: 'auditorContract',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. CABC...',
		displayOptions: showFor,
		description: 'The address of the auditor registry contract, starting with C',
	},
	{
		displayName: 'State Folder',
		name: 'stateFolder',
		type: 'string',
		default: '',
		placeholder: 'e.g. /data/stellar-confidential',
		displayOptions: showFor,
		// OpenZeppelin, docs-oz/build-with-the-sdk.mdx: "Balance openings live only in events and your
		// store. RPC keeps about 7 days of events". ADR 0106: without the state the funds are
		// "unspendable".
		description:
			"The folder where the node keeps each account's encrypted state and the CRS for proofs. Leave empty to use ~/.n8n/stellar-confidential. Keep it: the RPC keeps only about 7 days of events, and without this state older funds can't be spent.",
	},
	{
		displayName: 'Threads',
		name: 'threads',
		type: 'number',
		typeOptions: {
			minValue: 1,
			numberPrecision: 0,
		},
		default: 1,
		displayOptions: showFor,
		// anexos/evidencia-prueba-bbjs-n8n-25-10/LEEME.md: 1 thread, 1,328 ms; 4 threads, 951 ms.
		description:
			'How many threads proof generation uses. More threads make proofs faster and use more CPU.',
	},
];

// A contract address of the node. It is checked before any request to the RPC.
export function readContract(
	context: IExecuteFunctions,
	node: INode,
	name: string,
	label: string,
	itemIndex: number,
): string {
	const value = context.getNodeParameter(name, itemIndex, '');
	if (typeof value !== 'string' || !StrKey.isValidContract(value.trim())) {
		throw new NodeOperationError(node, `'${label}' isn't a valid contract address`, {
			itemIndex,
			description: "Enter the contract's address: 56 characters starting with C.",
		});
	}
	return value.trim();
}

// The only network the node offers. Any other value fails instead of running on a network the user
// didn't choose.
export function readNetwork(context: IExecuteFunctions, node: INode, itemIndex: number): string {
	const value = context.getNodeParameter('network', itemIndex, NETWORK_NAME);
	if (value === NETWORK_NAME) {
		return value;
	}
	throw new NodeOperationError(node, "'Network' must be testnet", {
		itemIndex,
		description: 'Confidential Token works only on testnet.',
	});
}

// The folder of the state and the CRS: the parameter, or the default under ~/.n8n.
export function readStateFolder(context: IExecuteFunctions, itemIndex: number): string {
	const value = context.getNodeParameter('stateFolder', itemIndex, '');
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : defaultStateFolder();
}

export function readThreads(context: IExecuteFunctions, node: INode, itemIndex: number): number {
	const value = context.getNodeParameter('threads', itemIndex, 1);
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new NodeOperationError(node, "'Threads' must be a whole number, 1 or more", {
			itemIndex,
			description: 'Enter how many threads proof generation uses, for example 1 or 4.',
		});
	}
	return value;
}

// The errors of the state files and the account lock have a short message and a description, and
// are the node's own text. They are read by their name and properties, so no class is imported. The
// error that comes out has no cause: n8n would store what the original carries.
const STATE_ERRORS = ['AccountBusyError', 'StateInputError', 'StateFileError'];

export function stateErrorOf(
	node: INode,
	error: unknown,
	itemIndex: number,
): NodeOperationError | undefined {
	if (!(error instanceof Error) || !STATE_ERRORS.includes(error.constructor.name)) {
		return undefined;
	}
	const description =
		'description' in error && typeof error.description === 'string' ? error.description : undefined;
	return new NodeOperationError(node, error.message, { itemIndex, description });
}

// The network errors of the RPC client, by their code or name.
const NETWORK_ERROR_CODES = [
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'ETIMEDOUT',
	'ECONNABORTED',
];

// An error of the SDK or of its RPC client, other than a submission's, goes out with the node's own
// text and no cause: a rejected simulation carries the server's raw answer, whose diagnostic events
// can name amounts (ADR 0102, rule 6), and a network error can carry the RPC address, which can have
// a key in it (D-0216). A contract's error code becomes the SDK's text for it. Other errors, such as
// the node's own, keep their text.
export function sdkErrorOf(
	node: INode,
	error: unknown,
	itemIndex: number,
): NodeOperationError | undefined {
	if (!(error instanceof Error) || error instanceof NodeOperationError) {
		return undefined;
	}
	if (error.name === 'SimulationFailedError' || /^simulate \S+ failed/.test(error.message)) {
		const known = humanizeContractError(error.message);
		return new NodeOperationError(node, 'The token rejected the operation', {
			itemIndex,
			description: `${known ?? 'The RPC simulated the call and the token contract rejected it.'} Nothing was signed or sent.`,
		});
	}
	if (error.name === 'StateDivergedError') {
		return new NodeOperationError(node, "The saved state doesn't match the token's balance", {
			itemIndex,
			description:
				"An event was missed or applied twice since the last sync, so the node can't build a proof from this state. Nothing was signed or sent.",
		});
	}
	if (error.name === 'StateUnverifiedError') {
		return new NodeOperationError(node, "Couldn't check the saved state against the token", {
			itemIndex,
			description:
				'The RPC answered from a different ledger than the events it gave, which happens when the account is busy or the server lags. Run the node again.',
		});
	}
	const code = 'code' in error ? error.code : undefined;
	if (
		error.name === 'AxiosError' ||
		(typeof code === 'string' && NETWORK_ERROR_CODES.includes(code))
	) {
		return new NodeOperationError(node, "Couldn't complete the request to the RPC server", {
			itemIndex,
			description: 'Check the RPC URL and that the server answers, then run the node again.',
		});
	}
	return undefined;
}

// How a submission that didn't confirm ends, as the Stellar Signer names it.
export type Outcome = 'rejected' | 'not_submitted' | 'uncertain';

export interface SubmissionFailure {
	message: string;
	description: string;
	outcome: Outcome;
	txHash: string | null;
}

// The SDK's submission errors carry an outcome and, when the transaction was sent, its hash. They
// are read by their properties, so no class of the SDK is imported.
export function submissionFailureOf(error: unknown): SubmissionFailure | undefined {
	if (typeof error !== 'object' || error === null || !('outcome' in error)) {
		return undefined;
	}
	const { outcome } = error;
	if (outcome !== 'rejected' && outcome !== 'not_submitted' && outcome !== 'uncertain') {
		return undefined;
	}
	const hash = 'hash' in error && typeof error.hash === 'string' ? error.hash : null;
	const message =
		'message' in error && typeof error.message === 'string' ? error.message : 'Submission failed';
	// The SDK's own description, when the error has one, says more than the generic text.
	const own =
		'description' in error && typeof error.description === 'string' && error.description !== ''
			? error.description
			: undefined;
	return { message, description: own ?? describeOutcome(outcome, hash), outcome, txHash: hash };
}

function describeOutcome(outcome: Outcome, hash: string | null): string {
	const transaction = hash === null ? '' : ` The transaction hash is ${hash}.`;
	if (outcome === 'not_submitted') {
		return 'The transaction was not sent to the network, so nothing changed on the token.';
	}
	if (outcome === 'rejected') {
		return `The network did not apply the transaction, so nothing changed on the token.${transaction}`;
	}
	return `The node could not confirm whether the network applied the transaction.${transaction} Look it up before you run the node again.`;
}

// Runs an operation once per input item and returns one output item for each. A submission that
// didn't confirm comes out as the Stellar Signer's does: with Continue On Fail, the item has an
// error object with its outcome and hash. Any other error fails the item like the Stellar node's:
// with Continue On Fail the item comes out with it and the next one runs; without it, it stops the
// run.
export async function forEachItem(
	context: IExecuteFunctions,
	node: INode,
	run: (itemIndex: number) => Promise<IDataObject>,
): Promise<INodeExecutionData[]> {
	const items = context.getInputData();
	const returnData: INodeExecutionData[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			returnData.push({ json: await run(itemIndex), pairedItem: itemIndex });
		} catch (error) {
			const failure = submissionFailureOf(error);
			if (failure !== undefined) {
				if (context.continueOnFail()) {
					// n8n replaces the json of an item that has the error property, so this one goes out
					// without it, like the Stellar Signer's: with error as its only key and pairedItem as
					// an object, n8n adds the input item's fields on the error output.
					returnData.push({
						json: {
							error: {
								message: failure.message,
								description: failure.description,
								outcome: failure.outcome,
								txHash: failure.txHash,
							},
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(node, failure.message, {
					itemIndex,
					description: failure.description,
				});
			}
			const nodeError = sdkErrorOf(node, error, itemIndex) ?? errorOfNode(node, error, itemIndex);
			if (!context.continueOnFail()) {
				throw nodeError;
			}
			returnData.push({ json: items[itemIndex].json, error: nodeError, pairedItem: itemIndex });
		}
	}
	return returnData;
}
