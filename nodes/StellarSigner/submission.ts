import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	AccountRequiresMemoError,
	Horizon,
	NetworkError,
	type Transaction,
	TransactionFailedError,
} from '@stellar/stellar-sdk';

import { horizonUrlFor, type NetworkName } from '../shared/network';

// The SDK's own limit for the submission request, used for every request to Horizon.
const REQUEST_TIMEOUT_MS = 60000;

const ENTER_HORIZON_URL =
	"Enter the address of a Horizon server, for example https://horizon-testnet.stellar.org, or leave the field empty to use SDF's server for the network.";

// The hosts that are this same machine, as Stellar Lab lists them.
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// The Horizon client for the item's submission. A Horizon URL that can't be used fails the item
// here. A value without text, such as an expression that gives nothing, counts as empty. The
// address must be https. Plain http is accepted only for a server on this same machine, where
// nobody can sit between the node and Horizon.
export function horizonServerFor(
	node: INode,
	networkName: NetworkName,
	horizonUrl: unknown,
	itemIndex: number,
): Horizon.Server {
	const url = horizonUrlFor(networkName, String(horizonUrl ?? ''));
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: "'Horizon URL' isn't a valid URL",
			description: ENTER_HORIZON_URL,
		});
	}
	const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HOSTNAMES.includes(parsed.hostname);
	if (parsed.protocol !== 'https:' && !isLocalHttp) {
		throw new NodeOperationError(node, "'Horizon URL' must start with https://", {
			itemIndex,
			description:
				"This node submits to a Horizon server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server for the network.",
		});
	}
	// The SDK accepts any scheme once allowHttp is on, so the scheme is checked above.
	const horizon = new Horizon.Server(url, { allowHttp: isLocalHttp });
	// The SDK sets no time limit on its other requests, such as the memo check's.
	horizon.httpClient.defaults.timeout = REQUEST_TIMEOUT_MS;
	// A redirect would send the signed transaction to another server.
	horizon.httpClient.defaults.maxRedirects = 0;
	return horizon;
}

// Asks Horizon whether a destination of the transaction requires a memo (SEP-29). It runs before
// anything is signed, so a failure here means the item was neither signed nor sent. The SDK only
// asks for a payment, a path payment or an account merge to a G address, in a transaction
// without a memo.
export async function checkMemoRequired(
	node: INode,
	horizon: Horizon.Server,
	transaction: Transaction,
	itemIndex: number,
): Promise<void> {
	try {
		await horizon.checkMemoRequired(transaction);
	} catch (error) {
		// The address and the host go in the description: n8n replaces a message that happens to
		// contain one of Node's error codes, and an address can.
		if (error instanceof AccountRequiresMemoError) {
			throw new NodeOperationError(node, error, {
				itemIndex,
				message: 'The destination requires a memo',
				description: `Operation ${error.operationIndex + 1} pays ${error.accountId}, an account that asks for a memo (SEP-29). This item was not signed or sent. Build the transaction again with the memo that destination gives you.`,
			});
		}
		const host = horizon.serverURL.host;
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: "Couldn't check whether the destination requires a memo",
			description:
				error instanceof NetworkError
					? `Horizon at ${host} answered with an error: ${error.message}. This item was not signed or sent. Wait and run it again.`
					: `Horizon at ${host} didn't answer. This item was not signed or sent. Check 'Horizon URL' and the connection, then run it again.`,
		});
	}
}

// What a submission that Horizon didn't confirm means for the transaction.
// - rejected: Horizon answered with result codes.
// - not_submitted: Horizon answered before passing it to the network.
// - uncertain: nobody gave a verdict, so the transaction may still be applied.
export type SubmissionOutcome = 'rejected' | 'not_submitted' | 'uncertain';

export interface SubmissionFailure {
	outcome: SubmissionOutcome;
	message: string;
	description: string;
	// The SDK's error, when there is one.
	cause?: unknown;
}

export type SubmissionResult = { ledger: number } | { failure: SubmissionFailure };

// Submits a signed transaction once and says what happened, without throwing. The memo check ran
// before signing, so it is skipped here.
export async function submitTransaction(
	horizon: Horizon.Server,
	transaction: Transaction,
	txHash: string,
): Promise<SubmissionResult> {
	let response: unknown;
	try {
		response = await horizon.submitTransaction(transaction, { skipMemoRequiredCheck: true });
	} catch (error) {
		return { failure: failureFrom(error, transaction, txHash) };
	}
	// The SDK takes any 200 as a success. Horizon's answer is the transaction itself: its hash, the
	// ledger that included it, and successful.
	if (
		isRecord(response) &&
		response.hash === txHash &&
		Number.isInteger(response.ledger) &&
		response.successful === true
	) {
		return { ledger: response.ledger as number };
	}
	return {
		failure: uncertain(transaction, txHash, "the answer isn't a Horizon result for it", false),
	};
}

// The transaction result codes that don't prove the transaction wasn't applied: Horizon can also
// answer them when the same signed transaction was sent before.
const REJECTIONS_TO_DOUBLE_CHECK: Record<string, (transaction: Transaction) => string> = {
	tx_bad_seq: () =>
		"Its sequence number doesn't match the source account. If this same transaction was sent before, it may already be applied: look it up on Horizon by its hash before you build a new one. If it was never sent, another transaction used that number: build a new one.",
	tx_too_late: (transaction) =>
		`It expired${expiryOf(transaction) === undefined ? '' : ` at ${expiryOf(transaction)}`}. If it was sent before that time, check that it wasn't applied: look it up on Horizon by its hash. If it isn't there, build a new transaction.`,
};

function failureFrom(error: unknown, transaction: Transaction, txHash: string): SubmissionFailure {
	const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
	const status = typeof response?.status === 'number' ? response.status : undefined;

	// Horizon applies or rejects a transaction with a 400 that has result codes.
	if (error instanceof TransactionFailedError && status === 400) {
		const codes = error.getResultCodes();
		if (typeof codes.transaction === 'string') {
			const operations = (codes.operations ?? []).filter((code) => typeof code === 'string');
			const describe = REJECTIONS_TO_DOUBLE_CHECK[codes.transaction];
			return {
				outcome: 'rejected',
				message: `Horizon rejected transaction ${txHash}: ${codes.transaction}${operations.length === 0 ? '' : ` (${operations.join(', ')})`}`,
				description:
					describe === undefined
						? "The transaction didn't take effect. Fix what the result codes say and build a new transaction. The codes are explained at https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/result-codes"
						: describe(transaction),
				cause: error,
			};
		}
	}

	if (status === undefined) {
		// The SDK's client reports its time limit with this code. Anything else is a connection
		// that failed, before or after Horizon received the transaction: the SDK can't tell.
		const timedOut = isRecord(error) && error.code === 'ECONNABORTED';
		return uncertain(
			transaction,
			txHash,
			timedOut ? `no answer in ${REQUEST_TIMEOUT_MS / 1000} seconds` : 'the connection failed',
			true,
			error,
		);
	}

	// Horizon's own 4xx answers come before it passes the transaction to the network. The
	// exception is 499, which it writes after that when the client disconnects.
	const problem = horizonProblemTitle(response?.data, status);
	if (status >= 400 && status < 500 && status !== 499 && problem !== undefined) {
		return {
			outcome: 'not_submitted',
			message: `Horizon didn't accept transaction ${txHash}: ${statusText(status)}`,
			description: `Horizon answered "${problem}" before passing it to the network, so it was not submitted. Sending this same signed transaction again is safe.`,
			cause: error,
		};
	}

	return uncertain(
		transaction,
		txHash,
		`the server answered ${statusText(status)}`,
		problem !== undefined,
		error,
	);
}

// A second item of the run with a transaction that an earlier item already sent.
export function sameTransactionFailure(firstItemIndex: number, txHash: string): SubmissionFailure {
	return {
		outcome: 'not_submitted',
		message: `This item has the same transaction as item ${firstItemIndex}`,
		description: `Transaction ${txHash} can be applied only once, so it pays once. Build a separate transaction for each payment.`,
	};
}

export interface AppliedTransaction {
	itemIndex: number;
	txHash: string;
	ledger: number;
}

// When an error stops the run, n8n drops the output of the items before it, but their
// transactions were applied. The error says how many and lists them, so nobody runs the workflow
// again from the start and pays them twice. n8n shows context.data as "Error data".
export function addAppliedTransactions(
	error: NodeOperationError,
	applied: AppliedTransaction[],
): void {
	const count =
		applied.length === 1
			? '1 earlier transaction in this run was applied'
			: `${applied.length} earlier transactions in this run were applied`;
	const list = applied.map(({ itemIndex, txHash }) => `item ${itemIndex} ${txHash}`).join(', ');
	error.message = `${error.message} (${count})`;
	error.description =
		`${error.description ?? ''} Already applied in this run, don't send them again: ${list}. Items after this one were not processed. Don't run the workflow from the start: that builds new transactions and pays the applied ones again.`.trim();
	error.context.data = { appliedTransactions: applied.map((transaction) => ({ ...transaction })) };
}

// Nobody said whether the transaction was applied. fromHorizon is false when the answer doesn't
// look like Horizon's, which usually means a wrong Horizon URL.
function uncertain(
	transaction: Transaction,
	txHash: string,
	reason: string,
	fromHorizon: boolean,
	cause?: unknown,
): SubmissionFailure {
	const expiry = expiryOf(transaction);
	const until =
		expiry === undefined
			? 'It has no time limit, so it can still be applied later. Look it up on Horizon by its hash.'
			: `It can still be applied until ${expiry}. Look it up on Horizon by its hash. If it isn't there after that time, it was not applied.`;
	return {
		outcome: 'uncertain',
		message: `The result of transaction ${txHash} is uncertain: ${reason}`,
		description: `${fromHorizon ? '' : "The answer doesn't look like Horizon's: check 'Horizon URL'. "}${until} Sending this same signed transaction again is safe: it can be applied only once. Don't build a new one for this payment until you know.`,
		cause,
	};
}

// When the transaction stops being valid, from its time bounds, or undefined if it never does.
function expiryOf(transaction: Transaction): string | undefined {
	const maxTime = Number(transaction.timeBounds?.maxTime ?? 0);
	if (!Number.isFinite(maxTime) || maxTime <= 0) {
		return undefined;
	}
	return `${new Date(maxTime * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// The title of a Horizon error body, which always has a type, a title and the HTTP status.
function horizonProblemTitle(body: unknown, status: number): string | undefined {
	if (
		isRecord(body) &&
		typeof body.type === 'string' &&
		typeof body.title === 'string' &&
		body.status === status
	) {
		return body.title;
	}
	return undefined;
}

// The status with its usual name. The server's own reason phrase isn't used: it can be anything.
const STATUS_NAMES: Record<number, string> = {
	400: 'Bad Request',
	403: 'Forbidden',
	404: 'Not Found',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
};

function statusText(status: number): string {
	return STATUS_NAMES[status] === undefined ? `${status}` : `${status} ${STATUS_NAMES[status]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
