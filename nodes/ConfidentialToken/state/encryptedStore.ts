import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';

import {
	bigintReplacer,
	reviveState,
	type StateStore,
} from '../../../vendor/stellar-confidential-token-sdk/src/state/store';
import type { AccountState } from '../../../vendor/stellar-confidential-token-sdk/src/state/types';

// The encrypted store for the Confidential Token state. The SDK's own file store writes the
// openings of the balances (`v` and `r`) as plain text. Those openings are the only local copy of
// what makes a confidential balance spendable, and anyone who reads them can see the balance. This
// store keeps one encrypted file per token and account instead.

// Names this store's key and its files. A change to either would make every saved file unreadable.
const STATE_LABEL = 'encendidos/confidential-token/state/v1';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

// The texts below never carry a balance, an opening, a key or the root, and they never repeat a
// value the caller gave: a wrong value could be a secret pasted in the wrong field. A message has
// no address and no path, because n8n replaces a message that contains one of Node's error codes.
// The specific text goes in the description.

// A value the caller gave is not usable: the key, the root, the token or the account.
export class StateInputError extends Error {
	readonly description: string;

	constructor(message: string, description: string) {
		super(message);
		this.name = 'StateInputError';
		this.description = description;
	}
}

// The state file can't be read, decrypted or written.
export class StateFileError extends Error {
	readonly description: string;

	constructor(message: string, description: string) {
		super(message);
		this.name = 'StateFileError';
		this.description = description;
	}
}

// The code of a failed file operation, such as ENOENT. It says nothing about the file's content.
function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === 'string' ? code : 'unknown';
}

// The state key is a different secret from the account's `sk`: it comes from the same root with
// its own label, so the key that guards the file is never the key that moves the balance. The root
// is the SEP-53 signature that the SDK derives `sk` from. This function keeps nothing.
export function deriveStateKey(root: Uint8Array): Uint8Array {
	if (!(root instanceof Uint8Array) || root.length === 0) {
		throw new StateInputError(
			'The root for the state key is empty',
			'The node could not derive the key that encrypts the saved Confidential Token state, ' +
				'because the signature it derives it from is empty. This is a fault in the node: report it.',
		);
	}
	const key = hkdfSync('sha256', root, new Uint8Array(0), STATE_LABEL, KEY_BYTES);
	return Uint8Array.from(new Uint8Array(key));
}

// The token and the account become part of a file name, so only a real contract address and a
// real account address get through. Neither can hold a separator or a dot.
export function checkTokenAndAccount(token: string, account: string): void {
	checkToken(token);
	checkAccount(account);
}

function checkToken(token: string): void {
	if (typeof token !== 'string' || !StrKey.isValidContract(token)) {
		throw new StateInputError(
			'The token is not a contract address',
			'The token must be the C address of a Confidential Token contract. Check the token ' +
				'address you entered.',
		);
	}
}

function checkAccount(account: string): void {
	if (typeof account !== 'string' || !StrKey.isValidEd25519PublicKey(account)) {
		throw new StateInputError(
			'The account is not a valid address',
			'The account must be a G address. Check the secret key of the credential and the account ' +
				'the item works on.',
		);
	}
}

// The cached openings are the only way to keep a balance spendable once its events age out of the
// RPC's window, so the file is never to be deleted. An RPC keeps 120960 ledgers by default, "about 7
// days" (https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction,
// read on 25-10-2026), and its operator can change that.
const DO_NOT_DELETE =
	'Do not delete it: the balance values saved in it are the only way to keep the confidential ' +
	'balance spendable once the RPC no longer has its events, which an RPC keeps for about 7 days ' +
	'by default.';

// The text of a file that exists but can't be used.
function unreadable(file: string, why: string): StateFileError {
	return new StateFileError(
		'The saved Confidential Token state could not be read',
		`The state file ${file} exists, but ${why} ${DO_NOT_DELETE} Restore the file from a ` +
			'backup, or check that the credential is the one that saved it, and run the item again.',
	);
}

// What the file holds is bound to the token and the account, so a copy under another name fails.
function additionalData(token: string, account: string): Buffer {
	return Buffer.from(`${STATE_LABEL}\n${token}\n${account}`, 'utf8');
}

type Opened = { state: AccountState } | { problem: 'format' | 'content' | 'account' };

// Decrypts and rebuilds a state. Any failure becomes a bare problem: the errors of the parser and
// of BigInt can quote the text they choke on, and that text is the decrypted content.
function openEnvelope(raw: Buffer, key: Buffer, token: string, account: string): Opened {
	try {
		const envelope = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
		if (
			envelope === null ||
			typeof envelope !== 'object' ||
			envelope.version !== FORMAT_VERSION ||
			envelope.algorithm !== ALGORITHM ||
			typeof envelope.iv !== 'string' ||
			typeof envelope.tag !== 'string' ||
			typeof envelope.data !== 'string'
		) {
			return { problem: 'format' };
		}
		const iv = Buffer.from(envelope.iv, 'base64');
		const tag = Buffer.from(envelope.tag, 'base64');
		if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return { problem: 'format' };

		const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(additionalData(token, account));
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([
			decipher.update(Buffer.from(envelope.data, 'base64')),
			decipher.final(),
		]);
		const json = plain.toString('utf8');
		plain.fill(0);

		const state = reviveState(JSON.parse(json) as Record<string, unknown>);
		if (
			typeof state.address !== 'string' ||
			typeof state.registered !== 'boolean' ||
			typeof state.syncedLedger !== 'number' ||
			typeof state.spendable.v !== 'bigint' ||
			typeof state.spendable.r !== 'bigint' ||
			typeof state.receiving.v !== 'bigint' ||
			typeof state.receiving.r !== 'bigint' ||
			(state.cursor !== undefined && typeof state.cursor !== 'string')
		) {
			return { problem: 'content' };
		}
		if (state.address !== account) return { problem: 'account' };
		return { state };
	} catch {
		return { problem: 'content' };
	}
}

// Best effort: a rename is only durable once its folder is flushed. Windows doesn't allow opening
// a folder, and a failure here must not hide a save that already happened.
async function flushFolder(folder: string): Promise<void> {
	try {
		const handle = await open(folder, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Nothing to do: the file itself was already flushed.
	}
}

export class EncryptedFileStore implements StateStore {
	readonly #folder: string;
	readonly #token: string;
	readonly #key: Buffer;

	constructor(folder: string, token: string, key: Uint8Array) {
		if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
			throw new StateInputError(
				'The state key is not valid',
				`The key that encrypts the saved Confidential Token state must be ${KEY_BYTES} bytes ` +
					'long. This is a fault in the node: report it.',
			);
		}
		checkToken(token);
		if (typeof folder !== 'string' || folder.length === 0) {
			throw new StateInputError(
				'The state folder is empty',
				'Set the folder where the node keeps the Confidential Token state.',
			);
		}
		this.#folder = folder;
		this.#token = token;
		// A copy, so that the caller can wipe its own key.
		this.#key = Buffer.from(key);
	}

	#fileFor(account: string): string {
		return join(this.#folder, `${this.#token}-${account}.state`);
	}

	async load(address: string): Promise<AccountState | null> {
		checkAccount(address);
		const file = this.#fileFor(address);

		let raw: Buffer | undefined;
		let failure: string | undefined;
		try {
			raw = await readFile(file);
		} catch (error) {
			failure = codeOf(error);
		}
		if (failure === 'ENOENT') return null;
		if (failure !== undefined || raw === undefined) {
			throw new StateFileError(
				'The saved Confidential Token state could not be opened',
				`The node could not read the state file ${file} (code ${failure ?? 'unknown'}). ` +
					`${DO_NOT_DELETE} Check the folder's permissions, or restore the file from a backup, ` +
					'and run the item again.',
			);
		}

		const opened = openEnvelope(raw, this.#key, this.#token, address);
		if ('state' in opened) return opened.state;
		if (opened.problem === 'format') {
			throw unreadable(
				file,
				"it isn't in a format this version of the node knows, or it was damaged.",
			);
		}
		if (opened.problem === 'account') {
			throw unreadable(file, 'it holds the state of another account.');
		}
		throw unreadable(
			file,
			'it could not be decrypted. It was saved with another key, or it was edited or damaged.',
		);
	}

	async save(state: AccountState): Promise<void> {
		checkAccount(state.address);
		const file = this.#fileFor(state.address);

		const plain = Buffer.from(JSON.stringify(state, bigintReplacer), 'utf8');
		let envelope: string;
		try {
			// A fresh IV on every save: GCM must never reuse one with the same key.
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, this.#key, iv, { authTagLength: TAG_BYTES });
			cipher.setAAD(additionalData(this.#token, state.address));
			const data = Buffer.concat([cipher.update(plain), cipher.final()]);
			envelope = JSON.stringify({
				version: FORMAT_VERSION,
				algorithm: ALGORITHM,
				iv: iv.toString('base64'),
				tag: cipher.getAuthTag().toString('base64'),
				data: data.toString('base64'),
			});
		} finally {
			plain.fill(0);
		}

		// The new content goes to a temporary file in the same folder and replaces the old one in a
		// single rename, so a stop in the middle leaves either the old file or the new one.
		const temporary = join(this.#folder, `${randomBytes(8).toString('hex')}.tmp`);
		let failure: string | undefined;
		let created = false;
		try {
			await mkdir(this.#folder, { recursive: true });
			const handle = await open(temporary, 'wx', 0o600);
			created = true;
			try {
				await handle.writeFile(envelope, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, file);
		} catch (error) {
			failure = codeOf(error);
		}

		if (failure !== undefined) {
			if (created) {
				try {
					await unlink(temporary);
				} catch {
					// The temporary file stays; it has no use and holds only encrypted content.
				}
			}
			throw new StateFileError(
				'The Confidential Token state could not be saved',
				`The node could not write the state file ${file} (code ${failure}). The previous state ` +
					'file, if there is one, was not changed. Do not delete it. Check that the folder ' +
					'exists or can be created, that it is writable and that the disk has room, and run ' +
					'the item again.',
			);
		}
		await flushFolder(this.#folder);
	}
}
