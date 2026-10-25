import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Horizon } from '@stellar/stellar-sdk';

import { horizonUrlFor, type NetworkName } from './network';

// The SDK's own limit for a transaction submission, used for every request to Horizon.
export const REQUEST_TIMEOUT_MS = 60000;

const ENTER_HORIZON_URL =
	"Enter the address of a Horizon server, for example https://horizon-testnet.stellar.org, or leave the field empty to use SDF's server for the network.";

// The hosts that are this same machine, as Stellar Lab lists them.
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// The Horizon client for an item, or for a trigger's poll, which has no item index. A Horizon URL
// that can't be used fails the item here. A value
// without text, such as an expression that gives nothing, counts as empty. The address must be
// https. Plain http is accepted only for a server on this same machine, where nobody can sit
// between the node and Horizon. The address can't carry a user name or a password. No error here
// repeats the address, which can have a key in it. Each node gives the description of the https
// error, which says what it does with the server.
export function horizonClientFor(
	node: INode,
	networkName: NetworkName,
	horizonUrl: unknown,
	itemIndex: number | undefined,
	notHttpsDescription: string,
): Horizon.Server {
	const url = horizonUrlFor(networkName, String(horizonUrl ?? ''));
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// The parser's own error repeats the address, so it isn't kept as the cause.
		throw new NodeOperationError(node, "'Horizon URL' isn't a valid URL", {
			itemIndex,
			description: ENTER_HORIZON_URL,
		});
	}
	const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HOSTNAMES.includes(parsed.hostname);
	if (parsed.protocol !== 'https:' && !isLocalHttp) {
		throw new NodeOperationError(node, "'Horizon URL' must start with https://", {
			itemIndex,
			description: notHttpsDescription,
		});
	}
	// The SDK's client doesn't send a request to an address with a user name or a password, and
	// its error repeats the whole address.
	const hasCredentials = parsed.username !== '' || parsed.password !== '';
	if (hasCredentials) {
		throw new NodeOperationError(node, "'Horizon URL' can't have a user name or a password", {
			itemIndex,
			description:
				"The node can't send requests to an address with a user name or a password in it. Remove them from the address, or leave the field empty to use SDF's server for the network.",
		});
	}
	// The SDK accepts any scheme once allowHttp is on, so the scheme is checked above.
	const horizon = new Horizon.Server(url, { allowHttp: isLocalHttp });
	// The SDK sets no time limit on its other requests, such as an account look-up.
	horizon.httpClient.defaults.timeout = REQUEST_TIMEOUT_MS;
	// A redirect would send the request to another server.
	horizon.httpClient.defaults.maxRedirects = 0;
	return horizon;
}

// What goes in the place of the Horizon URL in the node that is attached to an error.
const HIDDEN_HORIZON_URL = '[hidden by the node]';

// n8n attaches the node, with its saved parameters, to every error, stores that error with the
// execution and hands it to the error workflow. The address of a provider's Horizon can carry a
// key, so the copy of the node that goes into a node's errors has a mark in its place. Every node
// of the package names that parameter horizonUrl. n8n still keeps the address in the workflow and
// in its own copy of the node.
export function nodeForErrors(node: INode): INode {
	const { horizonUrl } = node.parameters;
	if (horizonUrl === undefined || horizonUrl === '') {
		return node;
	}
	return { ...node, parameters: { ...node.parameters, horizonUrl: HIDDEN_HORIZON_URL } };
}
