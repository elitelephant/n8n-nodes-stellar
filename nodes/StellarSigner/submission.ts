import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	AccountRequiresMemoError,
	Horizon,
	NetworkError,
	type Transaction,
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
