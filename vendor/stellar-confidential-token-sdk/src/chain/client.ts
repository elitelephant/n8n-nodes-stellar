/**
 * Soroban RPC client: read-only simulation, full invoke (build → simulate →
 * assemble → sign → send → poll), and typed reads of confidential state.
 *
 * No indexer. State that the protocol exposes only through events is read with
 * the RPC `getEvents` API (see `events.ts`), accepting its ~7-day retention
 * window — the central trade-off of this design.
 */

import {
  xdr,
  Address,
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  rpc,
} from "stellar-sdk-14"; // n8n-nodes-stellar: the 14.6.1 alias (VENDORED.md).
import type { FeeBumpTransaction, Transaction } from "stellar-sdk-14"; // n8n-nodes-stellar: submission (VENDORED.md).

import { pointFromBytes, type Point } from "../crypto/grumpkin.js";
import { fromBytesBE } from "../crypto/field.js";
import type { EscrowedDvk } from "../crypto/delegation.js";
import { parseContractErrorCode } from "./errors.js";

/** Source used for read-only simulation; never signs, never pays. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** `ConfidentialTokenError::AccountNotRegistered` — `confidential_balance` on an unknown account. */
const ACCOUNT_NOT_REGISTERED = 3501;

/** `ConfidentialTokenError::DelegationNotFound` — `get_spender_delegation` on an absent pair. */
const DELEGATION_NOT_FOUND = 3504;

// n8n-nodes-stellar: begin. Upstream polled every 2 s, up to 60 times; the node follows the
// Stellar Signer's rule (D-0219, D-0349): look the transaction up by its hash at once and then
// every 5 s, for up to 30 s (VENDORED.md).
const LOOKUP_INTERVAL_MS = 5000;
const LOOKUP_SECONDS = 30;
// n8n-nodes-stellar: end.

/**
 * Minimal transaction signer. A Node script wraps a {@link Keypair} via
 * {@link keypairSigner}; the web app wraps Freighter's `signTransaction`.
 */
export interface Signer {
  /** G-address of the signer (transaction source / auth principal). */
  publicKey: string;
  /** Sign an assembled transaction (base64 XDR) and return signed base64 XDR. */
  sign(txXdrBase64: string): Promise<string>;
}

export interface ContractIds {
  token: string;
  verifier: string;
  auditor: string;
}

export interface ChainConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: ContractIds;
}

export interface InvokeResult {
  hash: string;
  status: string;
  /** Return value of the invoked function (if any). */
  returnValue?: xdr.ScVal;
  /** n8n-nodes-stellar: the ledger that included the transaction (VENDORED.md). */
  ledger: number; // n8n-nodes-stellar: (VENDORED.md)
}

/** On-chain confidential account (`confidential_balance` return value). */
export interface OnChainAccount {
  spendingKey: Point;
  viewingPublicKey: Point;
  spendableBalance: Point;
  receivingBalance: Point;
  auditorId: number;
}

/** On-chain `(owner, spender)` delegation (`get_spender_delegation` return value). */
export interface OnChainDelegation {
  /** `C_a = Com(v_a, r_a)`. */
  allowanceCommitment: Point;
  /** `a_tilde = v_a + Poseidon2(ENCRYPTED_ALLOWANCE, dvk, σ_a)`. */
  aTilde: bigint;
  /** ECDH escrow of `dvk` under the spender's spending key. */
  escrowedDvk: EscrowedDvk;
  /** `σ_a`, the salt `C_a` and `a_tilde` are derived under. */
  allowanceSalt: bigint;
  /** Spendable while `ledger ≤ liveUntilLedger`; the value stays escrowed after. */
  liveUntilLedger: number;
}

/**
 * The RPC rejected a simulation (a contract panic, a host or storage error).
 * The message keeps the `simulate <method> failed: <host error>` form that
 * `humanizeContractError` parses; `latestLedger` is the ledger it ran against.
 */
export class SimulationFailedError extends Error {
  constructor(
    method: string,
    hostError: string,
    readonly latestLedger: number,
  ) {
    super(`simulate ${method} failed: ${hostError}`);
    this.name = "SimulationFailedError";
  }
}

export function keypairSigner(secret: string, networkPassphrase: string): Signer {
  const kp = Keypair.fromSecret(secret);
  return {
    publicKey: kp.publicKey(),
    async sign(txXdrBase64: string): Promise<string> {
      const tx = TransactionBuilder.fromXDR(txXdrBase64, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

export class ChainClient {
  readonly server: rpc.Server;

  constructor(readonly cfg: ChainConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
    });
  }

  // ----- reads -------------------------------------------------------------

  /** Simulate a read-only call and return its raw `ScVal` result. */
  async simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    return (await this.simulateAt(contractId, method, args)).retval;
  }

  /**
   * {@link simulate}, plus the ledger the simulation ran against (the
   * response's `latestLedger`) — for reads that are compared with an event
   * fetch through a given ledger. A rejected simulation throws a
   * {@link SimulationFailedError} carrying that ledger too.
   */
  async simulateAt(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<{ retval: xdr.ScVal; latestLedger: number }> {
    const account = await this.server
      .getAccount(NULL_ACCOUNT)
      .catch(() => new Account(NULL_ACCOUNT, "0"));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new SimulationFailedError(method, sim.error, sim.latestLedger);
    }
    const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
    if (!ok.result) throw new Error(`simulate ${method}: no result`);
    return { retval: ok.result.retval, latestLedger: ok.latestLedger };
  }

  /**
   * Read a confidential account, or `null` if `address` is not registered.
   *
   * Only the contract's `AccountNotRegistered` panic means "not registered".
   * Every other simulate failure (transport, rate limit, an archived entry,
   * any other contract error) propagates: reporting it as `null` would make an
   * unreachable chain look like an empty account, and the state engine's
   * consistency check would then call a healthy local state diverged. A
   * {@link parseAccount} failure is a real SDK/contract mismatch and propagates
   * too — swallowing it would report every account as unregistered after a
   * contract-side field rename.
   */
  async confidentialBalance(address: string): Promise<OnChainAccount | null> {
    return (await this.confidentialBalanceAt(address)).account;
  }

  /**
   * {@link confidentialBalance}, plus the ledger the read ran against — what
   * `StateEngine` compares with the ledger its events were fetched through.
   */
  async confidentialBalanceAt(
    address: string,
  ): Promise<{ account: OnChainAccount | null; latestLedger: number }> {
    let read: { retval: xdr.ScVal; latestLedger: number };
    try {
      read = await this.simulateAt(this.cfg.contracts.token, "confidential_balance", [
        new Address(address).toScVal(),
      ]);
    } catch (e) {
      if (e instanceof SimulationFailedError && parseContractErrorCode(e.message) === ACCOUNT_NOT_REGISTERED) {
        return { account: null, latestLedger: e.latestLedger };
      }
      throw e;
    }
    return { account: parseAccount(read.retval), latestLedger: read.latestLedger };
  }

  async isRegistered(address: string): Promise<boolean> {
    return (await this.confidentialBalance(address)) !== null;
  }

  /**
   * Read the `(owner, spender)` delegation, or `null` if none exists — never
   * delegated, or revoked. An expired entry is returned: its value is still
   * escrowed until revoked. Only `DelegationNotFound` maps to `null`; every
   * other failure propagates, as in {@link confidentialBalance}.
   */
  async spenderDelegation(owner: string, spender: string): Promise<OnChainDelegation | null> {
    return (await this.spenderDelegationAt(owner, spender)).delegation;
  }

  /**
   * {@link spenderDelegation}, plus the ledger the read ran against — what an
   * expiry check compares `liveUntilLedger` with.
   */
  async spenderDelegationAt(
    owner: string,
    spender: string,
  ): Promise<{ delegation: OnChainDelegation | null; latestLedger: number }> {
    let read: { retval: xdr.ScVal; latestLedger: number };
    try {
      read = await this.simulateAt(this.cfg.contracts.token, "get_spender_delegation", [
        new Address(owner).toScVal(),
        new Address(spender).toScVal(),
      ]);
    } catch (e) {
      if (e instanceof SimulationFailedError && parseContractErrorCode(e.message) === DELEGATION_NOT_FOUND) {
        return { delegation: null, latestLedger: e.latestLedger };
      }
      throw e;
    }
    return { delegation: parseDelegation(read.retval), latestLedger: read.latestLedger };
  }

  /** `is_spender(account, spender)`: a delegation exists AND is not expired. */
  async isSpender(owner: string, spender: string): Promise<boolean> {
    const retval = await this.simulate(this.cfg.contracts.token, "is_spender", [
      new Address(owner).toScVal(),
      new Address(spender).toScVal(),
    ]);
    return retval.b();
  }

  /** Fetch auditor key `K_aud` (BytesN<64>) for an `auditor_id`. */
  async auditorKey(auditorId: number): Promise<Point> {
    const retval = await this.simulate(this.cfg.contracts.auditor, "get_key", [
      xdr.ScVal.scvU32(auditorId),
    ]);
    return pointFromBytes(new Uint8Array(retval.bytes()));
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getHealth()).latestLedger;
  }

  // ----- writes ------------------------------------------------------------

  /**
   * Build, simulate, assemble, sign, submit, and poll a contract invocation.
   * Auth is taken from simulation; for these operations the source account is the
   * sole auth principal, so a single signature suffices.
   */
  async invoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signer: Signer,
  ): Promise<InvokeResult> {
    const source = await this.server.getAccount(signer.publicKey);
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(180)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${method} failed: ${sim.error}`);
    }
    const assembled = rpc.assembleTransaction(tx, sim).build();

    const signedXdr = await signer.sign(assembled.toXDR());
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);

    // n8n-nodes-stellar: begin. Submission with the Stellar Signer's rule (D-0219, D-0349),
    // in place of upstream's send and poll (VENDORED.md).
    return this.#submit(signedTx);
  }

  /**
   * Send a signed transaction once and say what happened. Only a transaction found in a ledger
   * returns; every other result throws a {@link SubmissionError} with its outcome. A
   * `sendTransaction` that gives no verdict (PENDING, DUPLICATE, an error, no answer) is
   * followed by a look-up by hash, at once and then every 5 s for up to 30 s.
   */
  async #submit(signedTx: Transaction | FeeBumpTransaction): Promise<InvokeResult> {
    const hash = signedTx.hash().toString("hex");
    const tx = "innerTransaction" in signedTx ? signedTx.innerTransaction : signedTx;
    const host = hostOf(this.cfg.rpcUrl);

    let send: unknown;
    let sendError: unknown;
    let sendFailed = false;
    try {
      send = await this.server.sendTransaction(signedTx);
    } catch (e) {
      sendFailed = true;
      sendError = e;
    }

    let pending: Unverdicted;
    if (sendFailed) {
      pending = this.#noAnswer(sendError, host);
    } else if (!isRecord(send) || send.hash !== hash || typeof send.status !== "string") {
      pending = { from: UNVERDICTED_FROM.foreign(host), reason: "the answer isn't an RPC result for it" };
    } else if (send.status === "ERROR") {
      const result = send.errorResult instanceof xdr.TransactionResult ? send.errorResult : undefined;
      throw rejectedOnSend(hash, resultCodes(result));
    } else if (send.status === "TRY_AGAIN_LATER") {
      throw tryAgainLater(hash);
    } else if (send.status === "PENDING") {
      pending = { from: UNVERDICTED_FROM.pending(host), reason: "it isn't in a ledger yet" };
    } else if (send.status === "DUPLICATE") {
      pending = { from: UNVERDICTED_FROM.duplicate(host), reason: "the RPC answered DUPLICATE" };
    } else {
      pending = { from: UNVERDICTED_FROM.foreign(host), reason: "the RPC answered an unknown status" };
    }

    for (let waited = 0; ; waited += LOOKUP_INTERVAL_MS) {
      const found = await this.#findByHash(hash);
      if (found === "unreachable") {
        throw uncertain(hash, tx, pending, COULD_NOT_LOOK_UP);
      }
      if (found !== "missing") {
        if (found.successful) {
          return { hash, status: "SUCCESS", returnValue: found.returnValue, ledger: found.ledger };
        }
        throw includedAsFailed(hash, found.ledger, found.codes);
      }
      if (waited >= LOOKUP_SECONDS * 1000) {
        throw uncertain(hash, tx, pending, NOT_FOUND_IN_TIME);
      }
      await sleep(LOOKUP_INTERVAL_MS);
    }
  }

  /**
   * What the RPC has for the hash: the transaction in a ledger, nothing yet, or no usable answer.
   * A look-up that fails is not repeated (D-0219): the result stays uncertain.
   */
  async #findByHash(
    hash: string,
  ): Promise<
    | { successful: boolean; ledger: number; returnValue?: xdr.ScVal; codes?: string }
    | "missing"
    | "unreachable"
  > {
    let res: rpc.Api.GetTransactionResponse;
    try {
      res = await this.server.getTransaction(hash);
    } catch {
      return "unreachable";
    }
    if (!isRecord(res) || (typeof res.txHash === "string" && res.txHash !== hash)) {
      return "unreachable";
    }
    if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return "missing";
    if (
      res.status !== rpc.Api.GetTransactionStatus.SUCCESS &&
      res.status !== rpc.Api.GetTransactionStatus.FAILED
    ) {
      return "unreachable";
    }
    const ledger = res.ledger;
    if (!Number.isSafeInteger(ledger) || ledger <= 0) return "unreachable";
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { successful: true, ledger, returnValue: res.returnValue };
    }
    return { successful: false, ledger, codes: resultCodes(res.resultXdr) };
  }

  /** Why `sendTransaction` gave no answer the node can use: nothing, or an error. */
  #noAnswer(error: unknown, host: string): Unverdicted {
    const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
    if (typeof response?.status === "number") {
      return { from: UNVERDICTED_FROM.error(host), reason: `the server answered ${response.status}` };
    }
    // A JSON-RPC error object, which the SDK throws as it comes. Its text is the server's: only
    // the code is named.
    if (isRecord(error) && typeof error.code === "number" && !(error instanceof Error)) {
      return { from: UNVERDICTED_FROM.error(host), reason: `the RPC answered error ${error.code}` };
    }
    if (isTimeout(error)) {
      const timeout = this.server.httpClient.defaults.timeout;
      const reason =
        typeof timeout === "number" && timeout > 0
          ? `no answer in ${Math.round(timeout / 1000)} seconds`
          : "no answer in time";
      return { from: UNVERDICTED_FROM.none(host), reason };
    }
    return { from: UNVERDICTED_FROM.none(host), reason: "the connection failed" };
  }
  // n8n-nodes-stellar: end.
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// n8n-nodes-stellar: begin. The outcomes and texts of a submission, as the Stellar Signer gives
// them (nodes/StellarSigner/submission.ts), naming the RPC instead of Horizon. No text carries an
// amount, a balance or a key (D-0337, rule 6), nor the server's own words (VENDORED.md).
//
// Sources, read with Stellar Raven on 25-10-2026 unless said otherwise:
// - https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/error-handling#async-transaction-submission
//   (Stellar-Core's PENDING, DUPLICATE, ERROR and TRY_AGAIN_LATER);
// - https://developers.stellar.org/docs/learn/fundamentals/contract-development/errors-and-debugging/debugging-errors#2-core-accepts-the-transaction
//   (Core's answer reaches the user through the RPC);
// - https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/result-codes/transactions
//   (txFAILED: "One of the operations failed (none were applied)"; txTOO_LATE: after the maxTime);
// - https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction and
//   .../getTransaction, read with WebFetch on 25-10-2026 (Raven doesn't index the method pages):
//   sendTransaction "simply validates and enqueues the transaction"; getTransaction answers
//   SUCCESS, NOT_FOUND or FAILED.

/**
 * What a submission that the network didn't confirm means for the transaction.
 * - rejected: the network didn't take it (ERROR), or it is in a ledger as failed.
 * - not_submitted: the RPC didn't pass it to the network (TRY_AGAIN_LATER).
 * - uncertain: no final result, so the transaction may still be applied.
 */
export type SubmissionOutcome = "rejected" | "not_submitted" | "uncertain";

/** A submission that didn't end in a ledger as successful. */
export class SubmissionError extends Error {
  constructor(
    readonly outcome: SubmissionOutcome,
    readonly hash: string | undefined,
    message: string,
    /** What it means and what to do, for the node's error description. */
    readonly description: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

const NOT_FOUND_IN_TIME = `The node looked for it on the RPC for ${LOOKUP_SECONDS} seconds and didn't find it.`;
const COULD_NOT_LOOK_UP = "The node couldn't look it up on the RPC.";

const RESULT_CODES_URL =
  "https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/result-codes/transactions";

/** A submission without a verdict: who said what, before the look-up. */
interface Unverdicted {
  /** The opening sentence of the description, naming the server. */
  from: string;
  /** Completes the message "The result of transaction <hash> is uncertain: …". */
  reason: string;
}

/** Only the host: the path of a provider's address can carry a key (D-0216). */
const UNVERDICTED_FROM = {
  none: (host: string) => `The RPC server at ${host} didn't answer.`,
  error: (host: string) => `The RPC server at ${host} answered with an error.`,
  foreign: (host: string) =>
    `The answer from ${host} doesn't look like an RPC result for this transaction: check 'RPC URL'.`,
  pending: (host: string) =>
    `The RPC server at ${host} passed it to the network (PENDING), which doesn't mean that a ledger will include it.`,
  duplicate: (host: string) =>
    `The RPC server at ${host} answered that this transaction was already submitted (DUPLICATE).`,
};

function rejectedOnSend(hash: string, codes: string | undefined): SubmissionError {
  return new SubmissionError(
    "rejected",
    hash,
    `The RPC rejected transaction ${hash}: ${codes ?? "ERROR"}`,
    `The submission didn't go through: Stellar-Core rejected the transaction when the RPC passed it on, so no ledger includes it. Fix what the result codes say and run this item again: the node builds a new transaction. The codes are explained at ${RESULT_CODES_URL}`,
  );
}

function tryAgainLater(hash: string): SubmissionError {
  return new SubmissionError(
    "not_submitted",
    hash,
    `The RPC didn't accept transaction ${hash}: TRY_AGAIN_LATER`,
    "Stellar-Core couldn't take this transaction now, for example because another transaction from the same source account is waiting, or because one with too low an inclusion fee was sent again too soon. It was not submitted. Wait, and run this item again: the node builds a new transaction.",
  );
}

function uncertain(
  hash: string,
  tx: Transaction,
  pending: Unverdicted,
  lookup: string,
): SubmissionError {
  const expiry = utcMinute(tx.timeBounds?.maxTime);
  const until =
    expiry === undefined
      ? "It has no time limit, so it can still be applied later. Look it up by its hash."
      : `It can still be applied until ${expiry}. Look it up by its hash. If it isn't there after that time, look at the account's sequence number: if it is lower than ${tx.sequence}, this transaction was not applied.`;
  return new SubmissionError(
    "uncertain",
    hash,
    `The result of transaction ${hash} is uncertain: ${pending.reason}`,
    `${pending.from} ${lookup} ${until} Don't run this item again until you know: if this transaction is applied, running the item again makes the operation twice.`,
  );
}

function includedAsFailed(hash: string, ledger: number, codes: string | undefined): SubmissionError {
  return new SubmissionError(
    "rejected",
    hash,
    `Transaction ${hash} is in ledger ${ledger} as failed`,
    `The RPC gave no final result when the node sent it, so the node looked it up: the network included it as failed${codes === undefined ? "" : ` (${codes})`}. Its operation had no effect, it was charged a fee and it used its sequence number. Running this item again builds a new transaction.`,
  );
}

/**
 * The transaction's result code, and each operation's, as the XDR names them: `txFailed
 * (invokeHostFunctionTrapped)`. Undefined if the result can't be read.
 */
function resultCodes(result: xdr.TransactionResult | undefined): string | undefined {
  if (result === undefined) return undefined;
  try {
    const inner = result.result();
    const code = inner.switch().name;
    if (code !== "txFailed" && code !== "txSuccess") return code;
    const operations = inner.results().map((op) => {
      if (op.switch().name !== "opInner") return op.switch().name;
      const arm = op.tr().value() as unknown as { switch(): { name: string } };
      return arm.switch().name;
    });
    return operations.length === 0 ? code : `${code} (${operations.join(", ")})`;
  } catch {
    return undefined;
  }
}

/**
 * A time bound, in seconds since 1970, as a date and time in UTC, rounded up to the minute: the
 * network takes a transaction until its maxTime, so showing it earlier would make the texts
 * conclude too soon that it wasn't applied. Zero means the bound isn't set.
 */
function utcMinute(timeBound: string | undefined): string | undefined {
  const seconds = Number(timeBound ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const minutes = Math.ceil(seconds / 60);
  return `${new Date(minutes * 60 * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the RPC URL";
  }
}

/** The SDK's client reports its time limit in one of three ways. */
function isTimeout(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "ECONNABORTED" ||
      error.name === "TimeoutError" ||
      (typeof error.message === "string" && /^timeout of \d+ms exceeded$/.test(error.message)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
// n8n-nodes-stellar: end.

/**
 * Decode the `ConfidentialAccount` struct returned by `confidential_balance`.
 *
 * The keys are the contract's struct field names verbatim (`storage.rs`), so
 * they move when the contract renames them — as `spending_key`/`spendable_balance`/
 * `receiving_balance` did, becoming `spending_public_key`/
 * `spendable_commitment`/`receiving_commitment`. The completeness check at the
 * end is what makes such a rename loud: without it an unrecognized key set
 * yields an all-`undefined` object that passes as a registered account and only
 * fails much later, inside commitment arithmetic.
 */
function parseAccount(val: xdr.ScVal): OnChainAccount {
  const entries = val.map();
  if (!entries) throw new Error("expected ScMap for ConfidentialAccount");
  const out: Partial<OnChainAccount> = {};
  for (const e of entries) {
    const key = e.key().sym().toString();
    switch (key) {
      case "spending_public_key":
        out.spendingKey = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "viewing_public_key":
        out.viewingPublicKey = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "spendable_commitment":
        out.spendableBalance = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "receiving_commitment":
        out.receivingBalance = pointFromBytes(new Uint8Array(e.val().bytes()));
        break;
      case "auditor_id":
        out.auditorId = e.val().u32();
        break;
    }
  }
  const missing = (
    ["spendingKey", "viewingPublicKey", "spendableBalance", "receivingBalance", "auditorId"] as const
  ).filter((k) => out[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `ConfidentialAccount is missing ${missing.join(", ")} — the contract's field names ` +
        `(${entries.map((e) => e.key().sym().toString()).join(", ")}) do not match this SDK build`,
    );
  }
  return out as OnChainAccount;
}

/**
 * Decode the `SpenderDelegation` struct returned by `get_spender_delegation`.
 * Field names are the contract's verbatim (`storage.rs`); a missing one throws
 * for the same reason as in {@link parseAccount}.
 */
export function parseDelegation(val: xdr.ScVal): OnChainDelegation {
  const entries = val.map();
  if (!entries) throw new Error("expected ScMap for SpenderDelegation");
  const out: Partial<OnChainDelegation> = {};
  const bytes = (e: xdr.ScMapEntry): Uint8Array => new Uint8Array(e.val().bytes());
  for (const e of entries) {
    switch (e.key().sym().toString()) {
      case "allowance_commitment":
        out.allowanceCommitment = pointFromBytes(bytes(e));
        break;
      case "a_tilde":
        out.aTilde = fromBytesBE(bytes(e));
        break;
      case "escrowed_dvk": {
        const b = bytes(e);
        if (b.length !== 64) throw new Error(`escrowed_dvk: expected 64 bytes, got ${b.length}`);
        out.escrowedDvk = { rX: fromBytesBE(b.subarray(0, 32)), cipher: fromBytesBE(b.subarray(32, 64)) };
        break;
      }
      case "allowance_salt":
        out.allowanceSalt = fromBytesBE(bytes(e));
        break;
      case "live_until_ledger":
        out.liveUntilLedger = e.val().u32();
        break;
    }
  }
  const missing = (
    ["allowanceCommitment", "aTilde", "escrowedDvk", "allowanceSalt", "liveUntilLedger"] as const
  ).filter((k) => out[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `SpenderDelegation is missing ${missing.join(", ")} — the contract's field names ` +
        `(${entries.map((e) => e.key().sym().toString()).join(", ")}) do not match this SDK build`,
    );
  }
  return out as OnChainDelegation;
}
