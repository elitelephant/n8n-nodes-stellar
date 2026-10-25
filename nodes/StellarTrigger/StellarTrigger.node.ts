import type {
	IDataObject,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { type Horizon, StrKey } from '@stellar/stellar-sdk';

import { horizonClientFor, nodeForErrors } from '../shared/horizon';
import { isNetworkName, type NetworkName } from '../shared/network';
import { findPayments, type PaymentsPage, type PaymentsQuery } from '../Stellar/transport/horizon';

const POLLS_OVER_HTTPS =
	"This node polls a Horizon server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server for the network.";

// Horizon gives at most 200 records per page. A poll reads up to 10 pages, and leaves the rest for
// the next one.
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

// What the Trigger keeps between polls, in its static data: the cursor of the last record it read,
// for which account and network. While the workflow is active, n8n keeps it in memory, and it saves
// it to the database when a poll returns items, right after activation and when the workflow is
// deactivated.
interface TriggerMemory {
	account?: string;
	networkName?: NetworkName;
	// A Horizon paging token, or FROM_START.
	cursor?: string;
}

// The cursor that means "from the account's first record": the account had no records when the
// Trigger started, so its create account operation is the first payment it gets.
const FROM_START = '0';

export class StellarTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stellar Trigger',
		name: 'stellarTrigger',
		icon: {
			light: 'file:../StellarSigner/stellarLogo.svg',
			dark: 'file:../StellarSigner/stellarLogo.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle: '={{ $parameter["event"] }}',
		description: 'Starts the workflow when a Stellar account receives a payment',
		defaults: {
			name: 'Stellar Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Trigger On',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Payment Received',
						value: 'paymentReceived',
						description:
							'A payment or path payment to the account, or the create account operation that creates it',
					},
				],
				default: 'paymentReceived',
			},
			{
				displayName: 'Account',
				name: 'account',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. GABC...',
				description:
					"The public key of the account to watch, starting with G. The first poll starts from now and doesn't bring the account's history. A manual test returns the last payment it received.",
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
				default: 'public',
				description:
					"The Stellar network of the account. Each output item has it in its 'networkName' field.",
			},
			{
				displayName: 'Horizon URL',
				name: 'horizonUrl',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://horizon.example.com',
				description:
					"The Horizon server to poll, as an https address. Plain http works only for localhost, and the address can't have a user name or a password. Leave empty to use SDF's server for the network: horizon-testnet.stellar.org for testnet and horizon.stellar.org for public.",
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		// The node that goes into every error: a copy with the Horizon URL hidden.
		const node = nodeForErrors(this.getNode());
		const networkName = readNetwork(node, this.getNodeParameter('network', 'public'));
		const horizon = horizonClientFor(
			node,
			networkName,
			this.getNodeParameter('horizonUrl', ''),
			undefined,
			POLLS_OVER_HTTPS,
		);
		const account = readAccount(node, this.getNodeParameter('account', ''));

		if (this.getMode() === 'manual') {
			return [[{ json: await lastPaymentReceived(node, horizon, account, networkName) }]];
		}

		const memory = this.getWorkflowStaticData('node') as TriggerMemory;
		if (memory.account !== account || memory.networkName !== networkName || !memory.cursor) {
			// The first poll, or one after the account or the network changed, starts from now.
			const cursor = await latestCursor(node, horizon, account);
			Object.assign(memory, { account, networkName, cursor });
			return null;
		}

		// The cursor goes into the memory only after every page was read: if a page fails, the poll
		// fails, and the next one reads the same records again instead of skipping them.
		let cursor = memory.cursor;
		const received: INodeExecutionData[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const records = await readPayments(node, horizon, account, {
				order: 'asc',
				limit: PAGE_SIZE,
				cursor: cursor === FROM_START ? undefined : cursor,
			});
			for (const record of records) {
				const item = receivedPaymentItem(record, account, networkName);
				if (item !== undefined) {
					received.push({ json: item });
				}
				// A record that isn't a payment to the account moves the cursor too.
				cursor = record.paging_token;
			}
			if (records.length < PAGE_SIZE) {
				break;
			}
		}
		memory.cursor = cursor;
		return received.length === 0 ? null : [received];
	}
}

// The account's payments on one page, or none if the account doesn't exist yet.
async function readPayments(
	node: INode,
	horizon: Horizon.Server,
	account: string,
	query: PaymentsQuery,
): Promise<PaymentsPage['records']> {
	const page = await findPayments(
		node,
		horizon,
		account,
		query,
		"Couldn't read the account's payments",
		undefined,
	);
	return page?.records ?? [];
}

// The cursor to start from now: the account's latest record, or its first one if it has none yet.
async function latestCursor(node: INode, horizon: Horizon.Server, account: string) {
	const [latest] = await readPayments(node, horizon, account, { order: 'desc', limit: 1 });
	return latest?.paging_token ?? FROM_START;
}

// The last payment the account received, among its latest operations, to show the shape of the
// data in a manual test.
async function lastPaymentReceived(
	node: INode,
	horizon: Horizon.Server,
	account: string,
	networkName: NetworkName,
): Promise<IDataObject> {
	const page = await findPayments(
		node,
		horizon,
		account,
		{ order: 'desc', limit: PAGE_SIZE },
		"Couldn't read the account's payments",
		undefined,
	);
	// The address goes in the description: n8n replaces a message that happens to contain one of
	// Node's error codes, and an address can.
	if (page === undefined) {
		throw new NodeOperationError(node, `The account doesn't exist on ${networkName}`, {
			description: `Horizon has no account ${account} on ${networkName}. Once the workflow is active, the trigger fires for the create account operation that creates it. To test it now, create the account first: on testnet, Friendbot can create it.`,
		});
	}
	for (const record of page.records) {
		const item = receivedPaymentItem(record, account, networkName);
		if (item !== undefined) {
			return item;
		}
	}
	throw new NodeOperationError(node, 'No payment received yet', {
		description: `Horizon has no payment received by ${account} on ${networkName} in the account's last ${PAGE_SIZE} operations. Send a payment to the account, then fetch the test event again.`,
	});
}

// The transaction that Horizon joins to each record, with its memo. The SDK keeps it in
// transaction_attr, which its types don't declare, and moves its ledger to ledger_attr.
type JoinedTransaction = Pick<
	Horizon.ServerApi.TransactionRecord,
	'memo_type' | 'memo' | 'ledger_attr'
>;

// The output item for a record that is a payment received by the account, or undefined for any
// other record: a payment the account sent, a contract call, or an account merge.
function receivedPaymentItem(
	record: PaymentsPage['records'][number],
	account: string,
	networkName: NetworkName,
): IDataObject | undefined {
	let transfer: { from: string; to: string; asset: string; amount: string } | undefined;
	if (record.type === 'create_account') {
		if (record.account === account) {
			transfer = {
				from: record.funder,
				to: record.account,
				asset: 'XLM',
				amount: record.starting_balance,
			};
		}
	} else if (
		record.type === 'payment' ||
		record.type === 'path_payment_strict_receive' ||
		record.type === 'path_payment_strict_send'
	) {
		if (record.to === account) {
			transfer = {
				from: record.from,
				to: record.to,
				asset: assetName(record.asset_type, record.asset_code, record.asset_issuer),
				amount: record.amount,
			};
		}
	}
	if (transfer === undefined) {
		return undefined;
	}
	const transaction = (record as { transaction_attr?: JoinedTransaction }).transaction_attr;
	return {
		...transfer,
		// As Horizon gives it: a text, an id in decimal, or a hash in base64.
		memo:
			transaction === undefined || transaction.memo_type === 'none'
				? null
				: (transaction.memo ?? null),
		txHash: record.transaction_hash,
		ledger: transaction?.ledger_attr ?? null,
		createdAt: record.created_at,
		networkName,
	};
}

// An asset as the Stellar Signer's policy writes it: XLM, or CODE:ISSUER.
function assetName(type: string, code: string | undefined, issuer: string | undefined): string {
	return type === 'native' ? 'XLM' : `${code}:${issuer}`;
}

function readNetwork(node: INode, value: unknown): NetworkName {
	if (isNetworkName(value)) {
		return value;
	}
	throw new NodeOperationError(node, "'Network' must be public or testnet", {
		description: 'Choose public or testnet in the Network parameter.',
	});
}

function readAccount(node: INode, value: unknown): string {
	if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
		throw new NodeOperationError(node, "'Account' isn't a valid Stellar public key", {
			description: 'Enter the public key of the account to watch: 56 characters, starting with G.',
		});
	}
	return value;
}
