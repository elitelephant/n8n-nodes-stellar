import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { type Horizon, NetworkError, NotFoundError } from '@stellar/stellar-sdk';

import { horizonClientFor } from '../../shared/horizon';
import type { NetworkName } from '../../shared/network';

const READS_OVER_HTTPS =
	"This node reads from a Horizon server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server for the network.";

// The Horizon client for an item, with the shared rules for Horizon URL.
export function horizonFor(
	node: INode,
	networkName: NetworkName,
	horizonUrl: unknown,
	itemIndex: number,
): Horizon.Server {
	return horizonClientFor(node, networkName, horizonUrl, itemIndex, READS_OVER_HTTPS);
}

// The account as Horizon has it now, with its sequence number. An account that doesn't exist on
// the network fails the item with a text of its own. The address goes in the description: n8n
// replaces a message that happens to contain one of Node's error codes, and an address can.
export async function loadSourceAccount(
	node: INode,
	horizon: Horizon.Server,
	accountId: string,
	networkName: NetworkName,
	itemIndex: number,
): Promise<Horizon.AccountResponse> {
	try {
		return await horizon.loadAccount(accountId);
	} catch (error) {
		if (error instanceof NotFoundError) {
			throw new NodeOperationError(node, error, {
				itemIndex,
				message: `The source account doesn't exist on ${networkName}`,
				description: `Horizon has no account ${accountId} on ${networkName}, so nothing was built. Check 'Source Account' and 'Network'. An account exists only after another account creates it with XLM; on testnet, Friendbot can create it.`,
			});
		}
		throw requestFailed(node, horizon, error, "Couldn't read the source account", itemIndex);
	}
}

// The base fee of the last ledger, per operation, in stroops. The SDK reads it from Horizon's
// fee_stats and falls back to the network's minimum, 100, when the answer has none.
export async function baseFee(
	node: INode,
	horizon: Horizon.Server,
	itemIndex: number,
): Promise<number> {
	try {
		return await horizon.fetchBaseFee();
	} catch (error) {
		throw requestFailed(node, horizon, error, "Couldn't read the network's base fee", itemIndex);
	}
}

// The time bounds for a transaction that the network accepts for timeLimit seconds, counted on
// Horizon's clock, so a wrong clock on this machine doesn't change it. The SDK takes the time from
// the last answer of the same server, and asks the server for it only when it has none.
export async function timeboundsFor(
	node: INode,
	horizon: Horizon.Server,
	timeLimit: number,
	itemIndex: number,
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
	itemIndex: number,
): NodeOperationError {
	const host = horizon.serverURL.host;
	return new NodeOperationError(node, error instanceof Error ? error : message, {
		itemIndex,
		message,
		description:
			error instanceof NetworkError
				? `Horizon at ${host} answered with an error. Wait and run it again, or check 'Horizon URL'.`
				: `Horizon at ${host} didn't answer. Check 'Horizon URL' and the connection, then run it again.`,
	});
}
