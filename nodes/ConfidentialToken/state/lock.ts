import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { checkTokenAndAccount } from './encryptedStore';

// One Confidential Token operation at a time on each token and account. Two at once would both
// read the saved balance and both save a new one, and the second save would overwrite the first
// with values that don't include it. The lock is a file made with an exclusive flag, so that the
// system lets only one process create it, whether it is this n8n process or another.

// Another operation holds the lock of this token and account.
export class AccountBusyError extends Error {
	readonly description: string;
	readonly lockFile: string;

	constructor(lockFile: string) {
		super('Another Confidential Token operation is running on this account');
		this.name = 'AccountBusyError';
		this.lockFile = lockFile;
		this.description =
			'Another Confidential Token operation is running on this account for this token. The ' +
			"node runs one at a time, because two would overwrite each other's saved state. If none " +
			'is running (for example, n8n stopped in the middle of one), delete the file ' +
			`${lockFile} and run the item again.`;
	}
}

function isExistsError(error: unknown): boolean {
	return (error as { code?: unknown } | null | undefined)?.code === 'EEXIST';
}

// Runs `run` while holding the account's lock. The lock is released when `run` ends, with a result
// or with an error.
export async function withAccountLock<T>(
	folder: string,
	token: string,
	account: string,
	run: () => Promise<T>,
): Promise<T> {
	checkTokenAndAccount(token, account);
	const lockFile = join(folder, `${token}-${account}.lock`);

	await mkdir(folder, { recursive: true });

	// The catch only records what happened. The helpers' errors can't be thrown inside it.
	let busy = false;
	let failure: unknown;
	let created = false;
	try {
		const handle = await open(lockFile, 'wx', 0o600);
		created = true;
		try {
			// Whoever finds a stale lock can see which process made it and when. No secrets.
			await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isExistsError(error)) busy = true;
		else failure = error ?? new Error('The lock file could not be created');
	}

	if (busy) throw new AccountBusyError(lockFile);
	if (failure !== undefined) {
		if (created) await release(lockFile);
		throw failure;
	}

	try {
		return await run();
	} finally {
		await release(lockFile);
	}
}

// A failure to delete the lock must not hide the result of an operation that may already have
// reached the network: the user could run it again. The lock stays, and the next run reports the
// busy account with the path of the file.
async function release(lockFile: string): Promise<void> {
	try {
		await unlink(lockFile);
	} catch {
		// Left on purpose, see above.
	}
}
