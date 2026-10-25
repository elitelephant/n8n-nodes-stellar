# Vendored: stellar-confidential-token-sdk

This folder is a copy of the Stellar Confidential Token SDK, the client that the Confidential Token
node uses to build witnesses, generate UltraHonk proofs and talk to the confidential token
contracts.

|          |                                                                                     |
| -------- | ----------------------------------------------------------------------------------- |
| Project  | https://github.com/brozorec/stellar-confidential-token-sdk                          |
| Author   | Boyan Barakov (brozorec)                                                            |
| License  | MIT, in `LICENSE`                                                                   |
| Commit   | `aad17069714713bcb36fa376d0f2a87743e8e2a7` (version 0.3.0, 24-10-2026)              |
| Protocol | `stellar-confidential` 0.8.0, OpenZeppelin `stellar-contracts` `v0.8.0` (`ddc327e`) |
| Copied   | 25-10-2026                                                                          |

Upstream says it is not published to npm yet. The code has not been audited: the README lists the
MUST-level requirements of the `stellar-confidential` SDK specification that it does not meet yet.

## What is copied

`src/`, `circuits/`, `LICENSE` and `README.md`, from that commit. The tests, scripts, `package.json`
and lock file stay upstream. Upstream's runtime dependencies are in the package's `package.json`,
pinned to the versions the SDK was tested with:

| Dependency              | Version                               |
| ----------------------- | ------------------------------------- |
| `@aztec/bb.js`          | 0.87.0                                |
| `@noir-lang/noir_js`    | 1.0.0-beta.11                         |
| `@noble/curves`         | 1.9.7                                 |
| `@noble/hashes`         | 1.8.0                                 |
| `@zkpassport/poseidon2` | 0.6.2                                 |
| `@stellar/stellar-sdk`  | 14.6.1, installed as `stellar-sdk-14` |

The Stellar Signer and the other nodes use `@stellar/stellar-sdk` 17.1.0. This SDK keeps 14.6.1, so
the package installs both, and this copy imports the old one through the npm alias `stellar-sdk-14`.

With this SDK in the package, npm puts `@noble/hashes` 1.8.0 at the top of `node_modules`, where
2.4.0 was before. `@stellar/stellar-sdk` 17.1.0 gets its own 2.4.0, and `@exodus/bytes`, which
17.1.0 uses and which accepts either major version, now resolves 1.8.0.

## How it is built

The package's own `tsc` compiles `src/` to CommonJS in
`dist/vendor/stellar-confidential-token-sdk/`, together with the circuit JSON files, so
`npm run build` builds it and the nodes load it with `require()`. Upstream publishes ES modules
only, and its `exports` map has no `require` condition. The package compiles with `target: es2020`
(it was `es2019`), because the SDK uses `bigint` literals. That target applies to every node in the
package. `circuits/vks/*.vk.bin` are not copied to `dist`: they are the verification keys a
deployment registers on the verifier contract, and the SDK does not read them.

The published package carries the compiled SDK in `dist`, and this folder's `LICENSE` and
`VENDORED.md` through `files` in `package.json`, as the MIT license asks.

ESLint and Prettier skip the copied files, so they keep upstream's style and the diff against
upstream stays as short as the list below. `VENDORED.md` and `additions/` are checked like the rest
of the package.

## Changes from upstream

Only these. Any other difference from the upstream commit is a mistake. Each changed line in `src/`
carries a comment that starts with `n8n-nodes-stellar:`, or sits between a
`n8n-nodes-stellar: begin` comment and a `n8n-nodes-stellar: end` comment.

- `src/chain/{admin,client,contract,events,factory,payload}.ts`: `@stellar/stellar-sdk` is imported
  as `stellar-sdk-14`.
- `src/chain/client.ts`, `ChainClient.invoke()`: the submission follows the Stellar Signer's rule
  (D-0219), applied to the RPC (D-0349), in place of upstream's poll every 2 s, up to 60 times:

  | RPC answer                                                            | Result                                                                     |
  | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
  | `sendTransaction` `ERROR`                                             | `rejected`, with the result codes                                          |
  | `sendTransaction` `TRY_AGAIN_LATER`                                   | `not_submitted`                                                            |
  | `PENDING`, `DUPLICATE`, an error, no answer, or an answer for another | look the transaction up by its hash at once, then every 5 s for up to 30 s |
  | `getTransaction` `SUCCESS` with a ledger above 0                      | returned, with its `ledger`                                                |
  | `getTransaction` `FAILED`                                             | `rejected`, in its ledger                                                  |
  | `getTransaction` `NOT_FOUND` after 30 s                               | `uncertain`                                                                |
  | the look-up itself fails or gives something else                      | `uncertain`, without asking again                                          |

  `InvokeResult` gains `ledger`. Every other result throws the new `SubmissionError`, with `outcome`
  (`rejected`, `not_submitted` or `uncertain`, the new `SubmissionOutcome`), `hash`, a short
  `message` and a `description`. The texts follow `nodes/StellarSigner/submission.ts`, name the RPC
  instead of Horizon, and carry no amount, balance or key, nor the server's own words. The
  simulation, its error text and the rest of the client don't change.

  The sources, read on 25-10-2026, are in a comment in the file: the Stellar docs pages on
  Stellar-Core's `PENDING`, `DUPLICATE`, `ERROR` and `TRY_AGAIN_LATER`
  (`data/apis/horizon/api-reference/errors/error-handling#async-transaction-submission`), on how
  Core's answer reaches the user through the RPC
  (`learn/fundamentals/contract-development/errors-and-debugging/debugging-errors`) and on the
  transaction result codes (`data/apis/horizon/api-reference/errors/result-codes/transactions`),
  read with Stellar Raven; and the RPC's `sendTransaction` and `getTransaction` method pages
  (`data/apis/rpc/api-reference/methods/`), read with WebFetch because Raven doesn't index them.

  The SDK's `rpc.Server` has no time limit and follows redirects. The node has to set both on
  `server.httpClient.defaults` (`timeout`, `maxRedirects = 0`), as `nodes/shared/horizon.ts` does
  for Horizon. `invoke()` reads that time limit only to name it in a text.

- `src/proving/artifacts.ts`: the circuits folder is found with `__dirname` instead of
  `import.meta.url`, which CommonJS does not have.
- `additions/globals.d.ts`, added: types for the two browser globals the SDK names, `crypto` and
  `localStorage`, because the package compiles without the DOM library.
