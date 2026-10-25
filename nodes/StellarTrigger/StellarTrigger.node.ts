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

import { toAmount, toStroops } from '../shared/amount';
import { assetName, toAsset } from '../shared/asset';
import { horizonClientFor, nodeForErrors } from '../shared/horizon';
import { isNetworkName, type NetworkName } from '../shared/network';
import {
	findPayments,
	HORIZON_PAGE_SIZE,
	joinedTransaction,
	type PaymentsPage,
	type PaymentsQuery,
	receivedTransfer,
	type Transfer,
} from '../Stellar/transport/horizon';

const POLLS_OVER_HTTPS =
	"This node polls a Horizon server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server for the network.";

// A poll reads up to 10 pages of the most records Horizon gives, and leaves the rest for the next
// one.
const PAGE_SIZE = HORIZON_PAGE_SIZE;
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
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { event: ['paymentReceived'] } },
				options: [
					{
						displayName: 'Asset',
						name: 'asset',
						type: 'string',
						default: '',
						placeholder: 'e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
						description:
							'Only payments in this asset start the workflow: XLM or native for lumens, or CODE:ISSUER for another asset',
					},
					{
						displayName: 'Minimum Amount',
						name: 'minimumAmount',
						type: 'string',
						default: '',
						placeholder: 'e.g. 10',
						description: 'Only payments of at least this amount start the workflow, to ignore spam',
					},
				],
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
		const filters = this.getNodeParameter('filters', {}) as IDataObject;
		const filter: PaymentFilter = {
			asset: readAssetFilter(node, filters.asset),
			minimum: readMinimumFilter(node, filters.minimumAmount),
		};

		if (this.getMode() === 'manual') {
			return [[{ json: await lastPaymentReceived(node, horizon, account, networkName, filter) }]];
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
				const transfer = receivedTransfer(record, account);
				if (transfer !== undefined && passes(transfer, filter)) {
					received.push({ json: itemFor(record, transfer, networkName) });
				}
				// A record that isn't a payment to the account, or that the filters leave out, moves
				// the cursor too.
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
	filter: PaymentFilter,
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
			description: `Horizon has no account ${account} on ${networkName}. Once the workflow is active, the trigger fires for the create account operation that creates it, if it passes 'Filters'. To test it now, create the account first: on testnet, Friendbot can create it.`,
		});
	}
	let filteredOut = false;
	for (const record of page.records) {
		const transfer = receivedTransfer(record, account);
		if (transfer !== undefined && passes(transfer, filter)) {
			return itemFor(record, transfer, networkName);
		}
		filteredOut ||= transfer !== undefined;
	}
	if (filteredOut) {
		throw new NodeOperationError(node, 'No payment received passes the filters', {
			description: `Among the account's last ${PAGE_SIZE} operations, Horizon has payments received by ${account} on ${networkName}, but none passes 'Filters'. Change the filters, or send a payment that passes them, then fetch the test event again.`,
		});
	}
	throw new NodeOperationError(node, 'No payment received yet', {
		description: `Horizon has no payment received by ${account} on ${networkName} in the account's last ${PAGE_SIZE} operations. Send a payment to the account, then fetch the test event again.`,
	});
}

// The output item for a payment received: what it moved, with its memo, its transaction and when.
function itemFor(
	record: PaymentsPage['records'][number],
	transfer: Transfer,
	networkName: NetworkName,
): IDataObject {
	const { memo, ledger } = joinedTransaction(record);
	return {
		...transfer,
		memo,
		txHash: record.transaction_hash,
		ledger,
		createdAt: record.created_at,
		networkName,
	};
}

// The filters of Payment Received: only payments in this asset, and of at least this amount, in
// stroops. Each one is off when its parameter is empty.
interface PaymentFilter {
	asset?: string;
	minimum?: bigint;
}

// The asset filter, as the policy writes it, or undefined for any asset. Spaces around it don't
// count.
function readAssetFilter(node: INode, value: unknown): string | undefined {
	if (value === undefined || isEmptyText(value)) {
		return undefined;
	}
	const asset = toAsset(typeof value === 'string' ? value.trim() : value);
	if (asset === undefined) {
		throw new NodeOperationError(node, "'Asset' isn't a valid Stellar asset", {
			description:
				'Write XLM or native for lumens, or CODE:ISSUER for another asset: its code, a colon, and the address of the account that issues it. Leave it empty for any asset.',
		});
	}
	return assetName(asset);
}

// The minimum amount filter, in stroops, or undefined for any amount.
function readMinimumFilter(node: INode, value: unknown): bigint | undefined {
	if (value === undefined || isEmptyText(value)) {
		return undefined;
	}
	const amount = toAmount(typeof value === 'string' ? value.trim() : value);
	if (amount === undefined) {
		throw new NodeOperationError(
			node,
			"'Minimum Amount' must be a positive number with up to 7 decimals",
			{
				description:
					'Enter the smallest amount that starts the workflow, for example 10 or 0.5, or leave it empty for any amount.',
			},
		);
	}
	return toStroops(amount);
}

function isEmptyText(value: unknown): boolean {
	return typeof value === 'string' && value.trim() === '';
}

// Whether a payment received passes the filters. A create account operation moves XLM, its
// starting balance, so the filters apply to it too.
function passes(transfer: Transfer, filter: PaymentFilter): boolean {
	if (filter.asset !== undefined && transfer.asset !== filter.asset) {
		return false;
	}
	return filter.minimum === undefined || toStroops(transfer.amount) >= filter.minimum;
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
