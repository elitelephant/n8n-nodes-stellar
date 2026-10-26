import { mkdir } from 'node:fs/promises';

import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { rpc, scValToNative, xdr } from 'stellar-sdk-14';

import {
	type AccountState,
	type ChainClient,
	StateEngine,
} from '../../../../vendor/stellar-confidential-token-sdk/src';
import { holderKeys, type HolderKeys } from '../../keys';
import { EncryptedFileStore } from '../../state/encryptedStore';
import { chainClientFor, type Contracts } from '../../transport/rpc';
import { readContract, readNetwork, readStateFolder, readThreads } from '../common';

// How far back the RPC keeps events when it doesn't say: about 7 days of ledgers (120,959 on testnet).
const FALLBACK_RETENTION_LEDGERS = 120000;

// OpenZeppelin, docs-oz/build-with-the-sdk.mdx: "RPC keeps about 7 days of events, so sync at least
// once per window". Both texts are the user's only sign that a balance may be short (D-0350).
const WARNING_GAP =
	'The last sync was longer ago than the RPC keeps events (about 7 days), so some events may be missing from this balance.';
const WARNING_NO_STATE =
	'There was no saved state, so the balance was rebuilt only from the events the RPC still keeps (about 7 days).';

// What the operations of the holder share: the parameters of the item, the credential's keys, the
// RPC client and the account's state store.
export interface HolderContext {
	node: INode;
	itemIndex: number;
	contracts: Contracts;
	threads: number;
	folder: string;
	secretKey: string;
	// The credential as n8n hands it over, for the policy fields. Its secret key never goes into an error.
	credential: Record<string, unknown>;
	client: ChainClient;
	account: string;
	keys: HolderKeys['keys'];
	store: EncryptedFileStore;
}

// Reads and checks the common parameters and the credential of an item, before any request to the
// RPC, and builds what every operation of the holder needs. The state folder is created here, so
// the account's lock can be taken in it.
export async function holderContext(
	context: IExecuteFunctions,
	node: INode,
	itemIndex: number,
): Promise<HolderContext> {
	readNetwork(context, node, itemIndex);
	const contracts = {
		token: readContract(context, node, 'confidentialContract', 'Token Contract', itemIndex),
		verifier: readContract(context, node, 'verifierContract', 'Verifier Contract', itemIndex),
		auditor: readContract(context, node, 'auditorContract', 'Auditor Contract', itemIndex),
	};
	const threads = readThreads(context, node, itemIndex);
	const folder = readStateFolder(context, itemIndex);
	const { secretKey, credential } = await readCredential(context, node, itemIndex);

	const client = chainClientFor(
		node,
		context.getNodeParameter('rpcUrl', itemIndex, ''),
		contracts,
		itemIndex,
	);
	const { account, keys, stateKey } = holderKeys(node, secretKey, contracts.token, itemIndex);
	const store = new EncryptedFileStore(folder, contracts.token, stateKey);
	await mkdir(folder, { recursive: true });
	return {
		node,
		itemIndex,
		contracts,
		threads,
		folder,
		secretKey,
		credential,
		client,
		account,
		keys,
		store,
	};
}

// The credential and its secret key. The key's text never goes into an error.
async function readCredential(
	context: IExecuteFunctions,
	node: INode,
	itemIndex: number,
): Promise<{ secretKey: string; credential: Record<string, unknown> }> {
	const credential = await context.getCredentials('confidentialTokenHolderApi');
	const { secretKey } = credential;
	if (typeof secretKey !== 'string' || secretKey.trim() === '') {
		throw new NodeOperationError(node, "The credential's 'Secret Key' is empty", {
			itemIndex,
			description: 'Enter the secret key of a Stellar account in the credential.',
		});
	}
	return { secretKey: secretKey.trim(), credential };
}

// Fails an item whose account isn't registered in the token, before anything is signed or sent.
// Deposit, Merge and Get Balance need the account's confidential keys on the token.
export async function requireRegistered(holder: HolderContext): Promise<void> {
	if ((await holder.client.confidentialBalance(holder.account)) === null) {
		throw new NodeOperationError(holder.node, "This account isn't registered in this token", {
			itemIndex: holder.itemIndex,
			description:
				'The account has to register in the token once before it can deposit, merge or read a balance. Run Register for this account first. Nothing was signed or sent.',
		});
	}
}

export interface SyncResult {
	state: AccountState;
	// A text when the balance may be short of events the RPC no longer keeps, or null.
	syncWarning: string | null;
}

// Syncs the account's state with the chain and says whether the balance can be trusted to include
// every event.
//
// fromLedger is only for an account whose first event is known to be at or after it, such as one
// that is registering now. Without it, a sync with no saved state starts at the oldest ledger the
// RPC keeps, which is the earliest an RPC-only client can read; with a saved state the sync follows
// its cursor and fromLedger doesn't matter.
//
// The warning has two cases (D-0350). With a saved state, the gap between the latest ledger and the
// state's synced ledger is longer than the RPC's window, so events in between are gone. Without a
// saved state, the account was registered before and its balance is only what the window holds.
// StateEngine.sync() re-commits the openings against the chain and throws if they differ, so a
// balance that comes out matches the chain.
export async function syncHolder(
	holder: HolderContext,
	options: { fromLedger?: number } = {},
): Promise<SyncResult> {
	const { client, store, keys, account } = holder;
	const prior = await store.load(account);
	const { oldest, latest } = await retention(client);

	let syncWarning: string | null = null;
	if (prior !== null) {
		if (latest - prior.syncedLedger > latest - oldest) {
			syncWarning = WARNING_GAP;
		}
	} else if (options.fromLedger === undefined) {
		syncWarning = WARNING_NO_STATE;
	}

	const state = await new StateEngine({
		client,
		store,
		keys,
		address: account,
		fromLedger: options.fromLedger ?? oldest,
	}).sync();
	return { state, syncWarning };
}

const WARNING_NOT_SYNCED =
	"The transaction was applied, but the node couldn't sync the account's state afterwards. Run Get Balance to sync it before the next operation.";

export interface SyncAfterSend {
	// The synced ledger, or null when the sync failed.
	syncedLedger: number | null;
	syncWarning: string | null;
}

// Syncs after a transaction that the network applied. A sync that fails then doesn't fail the item:
// the transaction is already in, and failing would make a workflow send it again, such as a second
// deposit. The item says the state isn't synced instead, without the error's text.
export async function syncAfterSend(
	holder: HolderContext,
	options: { fromLedger?: number } = {},
): Promise<SyncAfterSend> {
	try {
		const { state, syncWarning } = await syncHolder(holder, options);
		return { syncedLedger: state.syncedLedger, syncWarning };
	} catch {
		return { syncedLedger: null, syncWarning: WARNING_NOT_SYNCED };
	}
}

// The oldest ledger the RPC keeps events from, and its latest.
async function retention(client: ChainClient): Promise<{ oldest: number; latest: number }> {
	const health = await client.server.getHealth();
	const reported = (health as { oldestLedger?: unknown }).oldestLedger;
	const oldest =
		typeof reported === 'number' && reported > 0
			? reported
			: Math.max(1, health.latestLedger - FALLBACK_RETENTION_LEDGERS);
	return { oldest, latest: health.latestLedger };
}

// The ledger of a confirmed transaction: the one the SDK reports, or the RPC's record of it. A
// look-up that fails gives null and doesn't fail the item, as in syncAfterSend: the transaction is
// already in.
export async function ledgerOf(
	client: ChainClient,
	sent: { hash: string },
): Promise<number | null> {
	const known = (sent as { ledger?: unknown }).ledger;
	if (typeof known === 'number' && known > 0) {
		return known;
	}
	const found = await client.server.getTransaction(sent.hash).catch(() => null);
	if (found === null) {
		return null;
	}
	const ledger = (found as { ledger?: unknown }).ledger;
	return typeof ledger === 'number' && ledger > 0 ? ledger : null;
}

export interface TokenInfo {
	// The contract of the public asset that the confidential token wraps.
	underlying: string;
	// XLM for the native asset, or CODE:ISSUER.
	asset: string;
	decimals: number;
}

const ISSUED_ASSET = /^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/;

// What the token wraps. The OpenZeppelin v0.8.0 example contract has no method that returns it
// (underlying_asset, decimals and name answer MissingValue on the three tokens of the Testnet
// deployment, 25-10-2026), but its instance storage keeps UnderlyingAsset. The wrapped asset's
// stellar asset contract (SAC) answers name(), which is native or CODE:ISSUER, and decimals().
export async function tokenInfo(
	client: ChainClient,
	token: string,
	node: INode,
	itemIndex: number,
): Promise<TokenInfo> {
	const underlying = await underlyingOf(client, token, node, itemIndex);
	const name = scValToNative(await client.simulate(underlying, 'name', []));
	const decimals = scValToNative(await client.simulate(underlying, 'decimals', []));
	if (typeof name !== 'string' || (name !== 'native' && !ISSUED_ASSET.test(name))) {
		throw new NodeOperationError(node, "Couldn't tell which asset this token wraps", {
			itemIndex,
			description:
				"The token's public asset is not a Stellar asset the node recognizes. Check the Token Contract address. Nothing was signed or sent.",
		});
	}
	// Amounts are written with 7 decimals, as in the Stellar node, so a token with other decimals
	// would read every amount wrong.
	if (decimals !== 7) {
		throw new NodeOperationError(node, "This token's asset doesn't use 7 decimals", {
			itemIndex,
			description:
				'The node writes amounts with 7 decimals, as the Stellar node does, and would read this token wrong. Nothing was signed or sent.',
		});
	}
	return { underlying, asset: name === 'native' ? 'XLM' : name, decimals };
}

async function underlyingOf(
	client: ChainClient,
	token: string,
	node: INode,
	itemIndex: number,
): Promise<string> {
	const notAToken = () =>
		new NodeOperationError(node, "Couldn't read the public asset of this token", {
			itemIndex,
			description:
				"The Token Contract has no confidential token's public asset on it. Check the address of the contract. Nothing was signed or sent.",
		});
	// The RPC's error for an entry it doesn't have becomes undefined. Any other failure is the
	// network's and goes on as it is, for sdkErrorOf to word.
	const found = await client.server
		.getContractData(token, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent)
		.catch((error: unknown) => {
			if (error instanceof Error && /not found/i.test(error.message)) {
				return undefined;
			}
			throw error;
		});
	if (found === undefined) {
		throw notAToken();
	}
	const storage = found.val.contractData().val().instance().storage() ?? [];
	for (const entry of storage) {
		const key = scValToNative(entry.key());
		if (key === 'UnderlyingAsset' || (Array.isArray(key) && key[0] === 'UnderlyingAsset')) {
			const value = scValToNative(entry.val());
			if (typeof value === 'string') {
				return value;
			}
		}
	}
	throw notAToken();
}
