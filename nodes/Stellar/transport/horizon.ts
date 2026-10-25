import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Asset, type Horizon, NetworkError, NotFoundError } from '@stellar/stellar-sdk';

import { fromStroops, toStroops } from '../../shared/amount';
import { assetName, assetOfBalance } from '../../shared/asset';
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

// The most records Horizon gives in one page.
export const HORIZON_PAGE_SIZE = 200;

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

// What a payment received by an account moved, as Horizon lists it under the account's payments.
export interface Transfer {
	from: string;
	to: string;
	// As the Stellar Signer's policy writes it: XLM or CODE:ISSUER.
	asset: string;
	amount: string;
}

// The transfer of a record that is a payment received by the account: a payment or a path payment to
// it, or the create account operation that creates it. Undefined for any other record: a payment the
// account sent, a contract call, or an account merge.
export function receivedTransfer(
	record: PaymentsPage['records'][number],
	account: string,
): Transfer | undefined {
	if (record.type === 'create_account') {
		return record.account === account
			? { from: record.funder, to: record.account, asset: 'XLM', amount: record.starting_balance }
			: undefined;
	}
	if (
		(record.type === 'payment' ||
			record.type === 'path_payment_strict_receive' ||
			record.type === 'path_payment_strict_send') &&
		record.to === account
	) {
		const asset =
			record.asset_type === 'native'
				? Asset.native()
				: new Asset(record.asset_code ?? '', record.asset_issuer);
		return { from: record.from, to: record.to, asset: assetName(asset), amount: record.amount };
	}
	return undefined;
}

// The transaction that Horizon joins to each record. The SDK keeps it in transaction_attr, which its
// types don't declare, and moves its ledger to ledger_attr.
type JoinedTransaction = Pick<
	Horizon.ServerApi.TransactionRecord,
	'memo_type' | 'memo' | 'ledger_attr'
>;

// The memo and the ledger of a record's joined transaction. The memo is as Horizon gives it: a text,
// an id in decimal, or a hash in base64, and null without one.
export function joinedTransaction(record: PaymentsPage['records'][number]): {
	memo: string | null;
	ledger: number | null;
} {
	const transaction = (record as { transaction_attr?: JoinedTransaction }).transaction_attr;
	return {
		memo:
			transaction === undefined || transaction.memo_type === 'none'
				? null
				: (transaction.memo ?? null),
		ledger: transaction?.ledger_attr ?? null,
	};
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

// The errors of requests to Horizon that didn't get what the node needs, as opposed to an item
// that is wrong: a batch fails whole for these.
const requestFailures = new WeakSet<object>();

export function isRequestFailure(error: unknown): boolean {
	return typeof error === 'object' && error !== null && requestFailures.has(error);
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
	const failure = new NodeOperationError(node, error instanceof Error ? error : message, {
		itemIndex,
		message,
		description,
	});
	requestFailures.add(failure);
	return failure;
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

// What an account holds of one asset, as Horizon writes the amounts: the asset as the policy writes
// it, the balance, what the account can spend of it, and the trustline's limit, null for XLM.
export type Balance = {
	asset: string;
	balance: string;
	spendable: string;
	limit: string | null;
};

// An account as Horizon has it now, with the base reserve of the last ledger, the minimum balance
// that reserve gives it, and its balances.
export interface AccountBalances {
	account: Horizon.AccountResponse;
	reserve: bigint;
	minimumBalance: bigint;
	balances: Balance[];
}

// Reads an account and what it holds, as Account › Get and the Stellar Trigger give it. An account
// that doesn't exist on the network fails. The address goes in the description: n8n replaces a
// message that happens to contain one of Node's error codes, and an address can.
export async function findBalances(
	node: INode,
	horizon: Horizon.Server,
	accountId: string,
	networkName: NetworkName,
	itemIndex: number | undefined,
): Promise<AccountBalances> {
	const account = await findAccount(
		node,
		horizon,
		accountId,
		"Couldn't read the account",
		itemIndex,
	);
	if (account === undefined) {
		throw new NodeOperationError(node, `The account doesn't exist on ${networkName}`, {
			itemIndex,
			description: `Horizon has no account ${accountId} on ${networkName}. Check 'Account' and 'Network'. An account exists only after another account creates it with XLM; on testnet, Friendbot can create it.`,
		});
	}
	const reserve = BigInt(await baseReserve(node, horizon, itemIndex));
	const minimumBalance = minimumBalanceOf(account, reserve);
	return { account, reserve, minimumBalance, balances: balancesOf(account, minimumBalance) };
}

// The XLM an account has to keep, in stroops, as Stellar's docs give it: two base reserves, one
// more for each subentry and each entry it sponsors for another account, and one less for each of
// its entries that another account sponsors.
function minimumBalanceOf(account: Horizon.AccountResponse, reserve: bigint): bigint {
	const entries = 2 + account.subentry_count + account.num_sponsoring - account.num_sponsored;
	return BigInt(entries) * reserve;
}

// One balance per asset, XLM first and then the trustlines in Horizon's order. Liquidity pool
// shares aren't listed. What the account can spend is its balance minus what its sell offers
// commit, and, for XLM, minus its minimum balance too. It is never below zero.
function balancesOf(account: Horizon.AccountResponse, minimumBalance: bigint): Balance[] {
	const balances: Balance[] = [];
	for (const line of account.balances) {
		const asset = assetOfBalance(line);
		if (asset === undefined || !('selling_liabilities' in line)) {
			continue;
		}
		const free = toStroops(line.balance) - toStroops(line.selling_liabilities);
		if (asset === 'XLM') {
			const spendable = spendableText(free - minimumBalance);
			balances.unshift({ asset, balance: line.balance, spendable, limit: null });
		} else if ('limit' in line) {
			const spendable = spendableText(free);
			balances.push({ asset, balance: line.balance, spendable, limit: line.limit });
		}
	}
	return balances;
}

// What is left to spend, never below zero, as Horizon writes an amount.
function spendableText(stroops: bigint): string {
	return fromStroops(stroops > BigInt(0) ? stroops : BigInt(0));
}
