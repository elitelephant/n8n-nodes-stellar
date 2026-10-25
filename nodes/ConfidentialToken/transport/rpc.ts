import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Networks } from '@stellar/stellar-sdk';

import { ChainClient } from '../../../vendor/stellar-confidential-token-sdk/src';
import { LOCAL_HOSTNAMES, REQUEST_TIMEOUT_MS } from '../../shared/horizon';

// SDF's RPC server for testnet, the one the Stellar docs use for Confidential Token.
const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

const ENTER_RPC_URL =
	"Enter the address of a Stellar RPC server, for example https://soroban-testnet.stellar.org, or leave the field empty to use SDF's server.";

export interface Contracts {
	token: string;
	verifier: string;
	auditor: string;
}

// The RPC client for an item. An RPC URL that can't be used fails the item here, with the same rules
// as the Horizon URL of the Stellar Signer: it must be https, or http for a server on this same
// machine; it can't carry a user name or a password; and no error repeats the address, which can
// have a key in it. A value without text, such as an expression that gives nothing, counts as empty.
export function chainClientFor(
	node: INode,
	rpcUrl: unknown,
	contracts: Contracts,
	itemIndex: number | undefined,
): ChainClient {
	const text = String(rpcUrl ?? '').trim();
	const url = text === '' ? TESTNET_RPC_URL : text;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// The parser's own error repeats the address, so it isn't kept as the cause.
		throw new NodeOperationError(node, "'RPC URL' isn't a valid URL", {
			itemIndex,
			description: ENTER_RPC_URL,
		});
	}
	const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HOSTNAMES.includes(parsed.hostname);
	if (parsed.protocol !== 'https:' && !isLocalHttp) {
		throw new NodeOperationError(node, "'RPC URL' must start with https://", {
			itemIndex,
			description:
				"This node reads from and sends to an RPC server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server.",
		});
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new NodeOperationError(node, "'RPC URL' can't have a user name or a password", {
			itemIndex,
			description:
				"The node can't send requests to an address with a user name or a password in it. Remove them from the address, or leave the field empty to use SDF's server.",
		});
	}
	// The client allows http for any address that starts with it, so the host is checked above.
	const client = new ChainClient({
		rpcUrl: url,
		networkPassphrase: Networks.TESTNET,
		contracts,
	});
	// The SDK sets no time limit, so a request that hangs, such as sendTransaction, would hang the
	// item. A redirect would send the request to another server.
	client.server.httpClient.defaults.timeout = REQUEST_TIMEOUT_MS;
	client.server.httpClient.defaults.maxRedirects = 0;
	return client;
}

// What goes in the place of the RPC URL in the node that is attached to an error.
const HIDDEN_RPC_URL = '[hidden by the node]';

// n8n attaches the node, with its saved parameters, to every error, stores that error with the
// execution and hands it to the error workflow. The address of a provider's RPC can carry a key, so
// the copy of the node that goes into this node's errors has a mark in its place. n8n still keeps the
// address in the workflow and in its own copy of the node.
export function nodeForErrors(node: INode): INode {
	const { rpcUrl } = node.parameters;
	if (rpcUrl === undefined || rpcUrl === '') {
		return node;
	}
	return { ...node, parameters: { ...node.parameters, rpcUrl: HIDDEN_RPC_URL } };
}
