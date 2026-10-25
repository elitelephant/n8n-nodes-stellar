import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { type Horizon, NetworkError, NotFoundError } from '@stellar/stellar-sdk';

import { horizonClientFor } from '../../shared/horizon';
import type { NetworkName } from '../../shared/network';

const READS_OVER_HTTPS =
	"This node reads from a Horizon server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server for the network.";

// The Horizon client for an item, with the shared rules for Horizon URL. The Stellar Trigger reads
// Horizon the same way as the Stellar node, so it uses this transport too, with its own client and
// no item index: a trigger has no items.
export function horizonFor(
	node: INode,
	networkName: NetworkName,
	horizonUrl: unknown,
	itemIndex: number | undefined,
): Horizon.Server {
	return horizonClientFor(node, networkName, horizonUrl, itemIndex, READS_OVER_HTTPS);
}

// An account as Horizon has it now, with its sequence number and its data, or undefined if the
// network doesn't have it.
export async function findAccount(
	node: INode,
	horizon: Horizon.Server,
	accountId: string,
	failure: string,
	itemIndex: number | undefined,
): Promise<Horizon.AccountResponse | undefined> {
	return await unlessMissing(
		node,
		horizon,
		async () => await horizon.loadAccount(accountId),
		failure,
		itemIndex,
	);
}

// A transaction as Horizon has it, by its hash, or undefined if this server doesn't have it.
export async function findTransaction(
	node: INode,
	horizon: Horizon.Server,
	txHash: string,
	failure: string,
	itemIndex: number | undefined,
): Promise<Horizon.ServerApi.TransactionRecord | undefined> {
	return await unlessMissing(
		node,
		horizon,
		async () => await horizon.transactions().transaction(txHash).call(),
		failure,
		itemIndex,
	);
}

// What a request to Horizon gives, or undefined when Horizon doesn't have what it asked for. Only
// Horizon's own not_found says so: the SDK gives the same error for any 404, also one from a server
// that isn't Horizon.
async function unlessMissing<T>(
	node: INode,
	horizon: Horizon.Server,
	request: () => Promise<T>,
	failure: string,
	itemIndex: number | undefined,
): Promise<T | undefined> {
	try {
		return await request();
	} catch (error) {
		if (error instanceof NotFoundError && horizonErrorType(error.getResponse()) === 'not_found') {
			return undefined;
		}
		throw requestFailed(node, horizon, error, failure, itemIndex);
	}
}

// What Horizon lists under an account's payments: payments, path payments, account creations and
// merges, and contract calls.
export type PaymentsPage = Awaited<ReturnType<ReturnType<Horizon.Server['payments']>['call']>>;

// Which page of an account's payments to read. Without a cursor, the page starts at the first or
// the last record, by its order.
export interface PaymentsQuery {
	order: 'asc' | 'desc';
	limit: number;
	cursor?: string;
}

// One page of the operations that moved funds to or from an account, as Horizon lists them under
// its payments, with each transaction joined so its memo is there. Undefined if the network doesn't
// have the account.
export async function findPayments(
	node: INode,
	horizon: Horizon.Server,
	accountId: string,
	page: PaymentsQuery,
	failure: string,
	itemIndex: number | undefined,
): Promise<PaymentsPage | undefined> {
	const request = horizon
		.payments()
		.forAccount(accountId)
		.order(page.order)
		.limit(page.limit)
		.join('transactions');
	if (page.cursor !== undefined) {
		request.cursor(page.cursor);
	}
	return await unlessMissing(node, horizon, async () => await request.call(), failure, itemIndex);
}

// The base fee of the last ledger, per operation, in stroops. The SDK reads it from Horizon's
// fee_stats and falls back to the network's minimum, 100, when the answer has none.
export async function baseFee(
	node: INode,
	horizon: Horizon.Server,
	itemIndex: number | undefined,
): Promise<number> {
	try {
		return await horizon.fetchBaseFee();
	} catch (error) {
		throw requestFailed(node, horizon, error, "Couldn't read the network's base fee", itemIndex);
	}
}

// The base reserve of the last ledger, in stroops: what each entry of an account adds to its
// minimum balance.
export async function baseReserve(
	node: INode,
	horizon: Horizon.Server,
	itemIndex: number | undefined,
): Promise<number> {
	const failure = "Couldn't read the network's base reserve";
	let latest: Horizon.ServerApi.LedgerRecord | undefined;
	try {
		[latest] = (await horizon.ledgers().order('desc').limit(1).call()).records;
	} catch (error) {
		throw requestFailed(node, horizon, error, failure, itemIndex);
	}
	if (latest === undefined || !Number.isSafeInteger(latest.base_reserve_in_stroops)) {
		throw new NodeOperationError(node, failure, {
			itemIndex,
			description: `The answer from ${horizon.serverURL.host} doesn't look like Horizon's: check 'Horizon URL'.`,
		});
	}
	return latest.base_reserve_in_stroops;
}

// The time bounds for a transaction that the network accepts for timeLimit seconds, counted on
// Horizon's clock, so a wrong clock on this machine doesn't change it. The SDK takes the time from
// the last answer of the same server, and asks the server for it only when it has none.
export async function timeboundsFor(
	node: INode,
	horizon: Horizon.Server,
	timeLimit: number,
	itemIndex: number | undefined,
): Promise<Horizon.Server.Timebounds> {
	try {
		return await horizon.fetchTimebounds(timeLimit);
	} catch (error) {
		throw requestFailed(node, horizon, error, "Couldn't read Horizon's time", itemIndex);
	}
}

// A request to Horizon that didn't get what the node needs. Only the host is named: the path of a
// provider's address can carry a key.
function requestFailed(
	node: INode,
	horizon: Horizon.Server,
	error: unknown,
	message: string,
	itemIndex: number | undefined,
): NodeOperationError {
	const host = horizon.serverURL.host;
	let description = `Horizon at ${host} didn't answer. Check 'Horizon URL' and the connection, then run it again.`;
	if (error instanceof NetworkError) {
		description =
			horizonErrorType(error.getResponse()) === undefined
				? `The answer from ${host} doesn't look like Horizon's: check 'Horizon URL'.`
				: `Horizon at ${host} answered with an error. Wait and run it again, or check 'Horizon URL'.`;
	}
	return new NodeOperationError(node, error instanceof Error ? error : message, {
		itemIndex,
		message,
		description,
	});
}

// Horizon names each of its errors with a type under this address.
const HORIZON_ERROR_TYPES = 'https://stellar.org/horizon-errors/';

// The name of a Horizon error, such as not_found, or undefined if the body isn't one of Horizon's.
function horizonErrorType(body: unknown): string | undefined {
	if (
		typeof body === 'object' &&
		body !== null &&
		'type' in body &&
		typeof body.type === 'string' &&
		body.type.startsWith(HORIZON_ERROR_TYPES)
	) {
		return body.type.slice(HORIZON_ERROR_TYPES.length);
	}
	return undefined;
}
