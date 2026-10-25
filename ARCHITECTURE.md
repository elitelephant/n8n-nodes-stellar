# Architecture

How the package's nodes use Stellar: which API each one talks to, what they read and build, the
assets they handle, the contracts of the Confidential Token deployment on Testnet, and the
transactions that show them working. The [README](README.md) describes each node for users.

## The nodes and the Stellar APIs they use

| Node                   | Stellar API                                                               | Holds a key                                           |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Stellar Signer**     | [Horizon](https://developers.stellar.org/docs/data/apis/horizon)          | Yes: the **Stellar Wallet API** credential            |
| **Stellar**            | Horizon                                                                   | No                                                    |
| **Stellar Trigger**    | Horizon                                                                   | No                                                    |
| **Confidential Token** | [Stellar RPC](https://developers.stellar.org/docs/data/apis/rpc), Testnet | Yes: the **Confidential Token Holder API** credential |

The Stellar Signer, the Stellar node and the Stellar Trigger work with classic payments, accounts
and trustlines, which Horizon serves as accounts, payment records joined with their transactions,
and transactions by hash. The Confidential Token node calls Soroban smart contracts, which need two
things that only the RPC gives:

- **Simulation.** A contract call is simulated before it is signed, to get its resources, fees and
  authorizations. "The Horizon API does not provide an endpoint to simulate a transaction execution"
  ([Stellar docs](https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-c-accounts#sending-a-transfer-via-horizon-api)).
- **Contract events.** A confidential account's balances are rebuilt from the token contract's
  events, read with the RPC's `getEvents`, whose "data retention window for these events is 7 days
  at most" ([Stellar docs](https://developers.stellar.org/docs/build/guides/events/ingest)). That is
  why the node keeps each account's state in a file of its own.

Each Horizon-based node takes an optional **Horizon URL**, and the Confidential Token node an
optional **RPC URL**. Both follow the same rules: `https`, or `http` only for `localhost`, no user
name or password, and the address kept out of the errors, which name only the server. Empty, the
nodes use SDF's servers: `horizon-testnet.stellar.org` and `horizon.stellar.org` for Horizon, and
`soroban-testnet.stellar.org` for the RPC.

## What each operation reads and builds

| Node › Operation                    | Reads (API)                                                                                                                              | Builds or sends                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stellar Signer › Sign Transaction   | With **Submit to Horizon**: the destination's `config.memo_required` (SEP-29), and the transaction by its hash after an uncertain result | Signs the XDR it receives; submits it to Horizon when asked                                                                        |
| Stellar Signer › Sign Message       | Nothing                                                                                                                                  | A SEP-53 signature                                                                                                                 |
| Stellar › Account › Get             | The account, and the last ledger for its base reserve (Horizon)                                                                          | Nothing                                                                                                                            |
| Stellar › Payment › Build           | The source account, the destination account (existence, trustline, SEP-29), the base fee and Horizon's time                              | One unsigned `payment` transaction per item                                                                                        |
| Stellar › Payment › Batch           | The same, once for the source and once per destination                                                                                   | One unsigned transaction with one `payment` operation per item, up to 100                                                          |
| Stellar › Payment › Check Paid      | The destination's latest payments, joined with their transactions for the memo                                                           | Nothing                                                                                                                            |
| Stellar › Payment › Get Transaction | The transaction by its hash                                                                                                              | Nothing                                                                                                                            |
| Stellar › Asset › Build Trustline   | The account, the base fee and Horizon's time                                                                                             | One unsigned `changeTrust` transaction per item                                                                                    |
| Stellar Trigger › Payment Received  | The account's payments, joined with their transactions, from a saved cursor                                                              | Nothing                                                                                                                            |
| Stellar Trigger › Balance Below     | The account and the last ledger (Horizon)                                                                                                | Nothing                                                                                                                            |
| Confidential Token › Register       | The account's confidential balance (a simulation of `confidential_balance`), then the token's events to rebuild its state (RPC)          | A zero-knowledge proof made locally, and a `register` contract call sent by the RPC                                                |
| Confidential Token › Deposit        | That the account is registered, and the token's underlying asset (RPC)                                                                   | A `deposit` contract call, without a proof                                                                                         |
| Confidential Token › Merge          | That the account is registered (RPC)                                                                                                     | A `merge` contract call, without a proof                                                                                           |
| Confidential Token › Get Balance    | The token's events since the last sync, and the account's confidential balance to check the rebuilt state against it (RPC)               | Nothing                                                                                                                            |
| Confidential Token › Transfer       | That the destination is registered, the account's state and balance, and the token's underlying asset (RPC)                              | A zero-knowledge proof made locally and a `confidential_transfer` contract call, after a `merge` if the spendable balance is short |
| Confidential Token › Withdraw       | The account's state and balance, and the token's underlying asset (RPC)                                                                  | A zero-knowledge proof made locally and a `withdraw` contract call, after a `merge` if the spendable balance is short              |

A Stellar transaction holds up to 100 operations
([Stellar docs](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering#inclusion-fee)),
which is the limit of **Payment › Batch**.

## Assets

- **XLM**, the native asset, written `XLM` or `native` in every node and credential field.
- **Issued (classic) assets**, written `CODE:ISSUER`: the asset's code, a colon, and the `G` address
  of the account that issues it. An account needs a trustline to hold one; **Asset › Build
  Trustline** builds it.
- **Confidential tokens.** Each confidential token holds an underlying asset through that asset's
  Stellar Asset Contract (SAC). The demo deployment below has one over XLM, one over its own asset
  `CONF`, and one over Circle's Testnet USDC. The holder's policy compares amounts in the underlying
  asset.

## Code layout

| Path                                     | What it holds                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes/shared/`                          | What several nodes share: network names and passphrases, the Horizon URL rules and client, the signing policy (`policy.ts`), amounts, assets, fees                          |
| `nodes/StellarSigner/`                   | The Signer, and its submission to Horizon with its outcomes (`submission.ts`)                                                                                               |
| `nodes/Stellar/`                         | One file per operation in `actions/<resource>/`, a router, and the Horizon reads in `transport/horizon.ts`                                                                  |
| `nodes/StellarTrigger/`                  | The poller, its two events, and its memory between polls                                                                                                                    |
| `nodes/ConfidentialToken/`               | The node, its operations, key derivation, the prover, the RPC client and, in `state/`, the encrypted state store and the account lock                                       |
| `credentials/`                           | **Stellar Wallet API** and **Confidential Token Holder API**                                                                                                                |
| `vendor/stellar-confidential-token-sdk/` | A copy of the Stellar Confidential Token SDK, compiled with the package. [VENDORED.md](vendor/stellar-confidential-token-sdk/VENDORED.md) lists its origin and every change |

## How the Confidential Token node keeps its secrets

- The holder's keys for the token come from a SEP-53 signature of the holder's Stellar key. The
  copied SDK's key derivation (`vendor/stellar-confidential-token-sdk/src/crypto/sk-derivation.ts`)
  asks a caller that signs to verify the signature, obtain it twice and never persist it. The node
  does that, and makes the signature again on every run.
- The account's state, which holds the openings of its confidential balances, goes into one file per
  token and account in the **State Folder**, encrypted with AES-256-GCM. The file's key comes from
  the same signature with a label of its own, so it is never the key that moves the balance.
- One operation at a time runs on each token and account: a lock file, created exclusively, makes a
  second one fail instead of overwriting the first one's state.
- The proofs are made inside the n8n installation, with `@aztec/bb.js`. The first proof downloads
  its setup file (the CRS) from `crs.aztec.network` into the state folder.
- Submissions go through the RPC and are judged like the Signer's: `rejected`, `not_submitted` or
  `uncertain`, with a look-up by hash before a result is called uncertain.
- The node is written so that no error text carries an amount, a balance or a key. No automated test
  checks that yet.

## The Confidential Token deployment on Testnet

The project deployed its own set of OpenZeppelin `stellar-contracts` v0.8.0 confidential token
contracts on Testnet on 25-10-2026, between ledgers 5386000 and 5386036, with an auditor key of its
own. Its contract instances live until about 01-11-2026, unless their time to live is extended.

| Contract                                 | Address                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| Verifier, with the six verification keys | `CAWVGHD7ZR2YD7D5UH5PTUWVS67DJ7ABP6ZQ4XAMV3TVE44ZUDYCNRAO` |
| Auditor registry (auditor id 0)          | `CBF2VJSIABFWMBVQ4GW54WGBJWJ6W76I5QZOHQOS3Z6FU4EVF7GIVI4P` |
| Factory                                  | `CDNZLMJR3VHWC5M4T5R5KDZLNO2COFOU2PB5BXFEQZSPTCALRF6L4MQP` |
| Confidential token over XLM              | `CAVEMZIUXLIZOL34KHC5APW7BIULK47OGAMHJ3ZPXFCT7V4BVT2QQ6QQ` |
| Its allowlist                            | `CBUCNW5YGUAG56RZ43IKW76EUQBJR5GUJCH6T3WEXXXOX7PQPSAPJTVE` |
| Confidential token over `CONF`           | `CAAQO5MEWFH5Z63OFQMBWJSOWSGPPYDFKDDLRQOF4SNFXRDRVHIIRTFB` |
| Its allowlist                            | `CDOVERJLRWTTLT6R47C6P6D7YLBOSQVJAG4MM4TVHQG6XNJ36FBM6DCY` |
| Confidential token over USDC             | `CA34WV3XSYKES7KUDYXAZAUOHL3JNJR2JUORZN22ZF2NGTWW43P37PTD` |
| Its allowlist                            | `CDDVIHVVHP2YIOPLH3EDXR7ITNZNSBV2OVLYKPUM2MFOD4HTYWKE5DSG` |

| Underlying asset | Asset                                                           | Its Stellar Asset Contract                                 |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| XLM              | `native`                                                        | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| CONF             | `CONF:GABW257OQ5OSPT4UHDCNMFOMEMTHVTZ7V742EF6ZWX6T7O6WNFJOCCIK` | `CCF3OFSVCHCXEO65AQBYKBGXUJIUDEZSYIDHSTGRJE3BSFQXPZHVWRJV` |
| USDC             | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

The deployment's administrator, `GDDXGY7BO6WBN7ELKYIEGMLAXCIUB4SS6O27PEYXC32GUJVP5UYC64UE`, holds
every role in this test deployment. The tokens are compliant tokens: an account has to be on a
token's allowlist to use it.

## Evidence on Testnet

Each transaction can be looked up by its hash on any Testnet explorer or Horizon server, for example
at `https://horizon-testnet.stellar.org/transactions/<hash>`.

| What                                                                                                                       | How it ran                                   | Transaction                                                        | Ledger  |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ | ------- |
| The demo: invoice `INV-1001`, 25 XLM to the supplier, built by **Payment › Build** and submitted by the **Stellar Signer** | n8n's engine (`n8n execute`), not the screen | `4d5f6d52c8b7fae8c81a2ee6dbacd33710313105287d4a5d51fb540dc48cac0a` | 5387451 |
| **Confidential Token › Holder › Register** of a new account in the token over XLM                                          | n8n's engine (`n8n execute`), not the screen | `bed12f3bbab810cc87a27b8da20d98269b862037bc1e61c954c855dfa74b5158` | 5388060 |
| A `merge` of the deployment's test holder in the token over XLM, through the SDK's submission with the Signer's outcomes   | A script on the package's compiled SDK       | `3d809d1fcdfe463fdf7f7afdd6304cd28d5d87f05b7c4b024a722c20bb3f5202` | 5387880 |
| The deployment's test holder registers in the token over XLM                                                               | The deployment script                        | `c12d35add940d83d5ae430e93c98a613d60b99f3d79a280dbc35a598da819b83` | 5386029 |
| **Register** of a new, allowed account in the token over XLM, by the end-to-end Testnet test                               | The test harness, on the compiled node       | `be6a2337c4c940f3763aee1973b9bd76bb21d46c411edd5e0a103c5d4a8efb6b` | 5387994 |
| An account registered with another key, set up so that **Register** with this credential fails without sending anything    | The SDK, as the test's setup                 | `7a795c70b1a3b1b236e609370d0d9aac2f4b81fdb705f81151bf133fab29af7a` | 5387998 |
| The end-to-end Testnet test of the balance, step 1: **Register** of a new account                                          | The test harness, on the compiled node       | `08ff71e6a893e8ef21f45d7ff6644b4b236d8e32286ee72b3fa573640d5b8170` | 5388343 |
| The same test, step 2: **Deposit** of 25 XLM                                                                               | The test harness, on the compiled node       | `cc43547f34dd7c9db245cbb395245d7e23b31e3d7112c33a896c52c06559e0c8` | 5388345 |
| The same test, step 3: **Merge**                                                                                           | The test harness, on the compiled node       | `c600ea6d5bc034e55127f43b1628337e863892d6055029def9024deec32308df` | 5388347 |
| The end-to-end Testnet test of the whole flow, step 1: **Register** of account A                                           | The test harness, on the compiled node       | `71759131518e8fdd716cb3a152c979780037fd4fe780a4a2c3a29b616b83f7a5` | 5388587 |
| Step 2: **Register** of account B                                                                                          | The test harness, on the compiled node       | `4beecc9fdb6c94fb4257099a0fbf5d26a6ee19340433679eb5b6fe5a7483404c` | 5388589 |
| Step 3: **Deposit** of 25 XLM into A                                                                                       | The test harness, on the compiled node       | `7af173552fbf1a748e00f3e74c8ed13495e0a1834fbd0215d1872a5d3497b12d` | 5388591 |
| Step 4: the automatic **Merge** of A before its transfer                                                                   | The test harness, on the compiled node       | `e71ee6805f37c427d1ed0972b988bd1362d5722e04472f9fe699e27069305f6e` | 5388593 |
| Step 5: **Transfer** of 10 XLM from A to B                                                                                 | The test harness, on the compiled node       | `261283e8facf550ac7cff1d14855e83e39ba95017d958bc4fd45f14b7393394b` | 5388595 |
| Step 6: **Merge** of B                                                                                                     | The test harness, on the compiled node       | `5c171a8acb9a134fbaaa2d60b3da602411ef238c7e6e87a7c451904562cae972` | 5388597 |
| Step 7: **Withdraw** of 5 XLM from B                                                                                       | The test harness, on the compiled node       | `443d27f505b8be0fd939583063400fc6f793693d58bf4279443ba55114a29a28` | 5388599 |
| Step 8: a run with two items of 1 XLM, first item                                                                          | The test harness, on the compiled node       | `e74228f0ffe0251722f96afefd1bd139cb08c6155d0d3b130bb585d6cd58a561` | 5388603 |
| Step 8: second item                                                                                                        | The test harness, on the compiled node       | `7a03c291b56d9dc187c79c5b417da915eb44a750b9db4ff9a4ca1b4b6ee58d99` | 5388606 |

A second run of the demo with the same invoice found it paid with **Payment › Check Paid** and
skipped it, so it sent nothing.

## Testing status

What was and wasn't tested, and since which commit, is in the README's
[testing status](README.md#testing-status). The transactions above are the Testnet evidence.
