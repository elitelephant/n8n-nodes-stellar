# Prior work and what was built at HackMeridian

This repository existed before HackMeridian 2026. This file says what was there before the event and
what was built during it, from 25-10-2026 at 09:00 Lisbon time, commit by commit. On 25-10-2026
Lisbon time is UTC+0, the time zone of the commit dates below.

## Before the event

| When                     | What                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11-07-2025               | Joaquín Soza ([`yripper/n8n-nodes-stellar`](https://github.com/yripper/n8n-nodes-stellar)) publishes `n8n-nodes-stellar` 0.1.0 and 0.1.1 on npm: one node, the **Stellar Signer**, which signs a transaction with a secret key kept in an n8n credential.                                                                                                  |
| 04-10-2026 to 16-10-2026 | This fork ([`elitelephant/n8n-nodes-stellar`](https://github.com/elitelephant/n8n-nodes-stellar)) maintains the Signer: `@n8n/node-cli`, `@stellar/stellar-sdk` 17.1.0 and fixes that keep version 1 of the node. Joaquín merges it as [PR #1](https://github.com/yripper/n8n-nodes-stellar/pull/1) on 16-10-2026 and publishes 0.2.0 on npm the same day. |
| 10-10-2026 to 18-10-2026 | The fork adds to the Signer the submission to Horizon with its outcomes (`rejected`, `not_submitted`, `uncertain`), the signing policy in the credential, and Sign Message. It is [PR #2](https://github.com/yripper/n8n-nodes-stellar/pull/2), open since 18-10-2026 (Chile time). Its last commit is `8100935`.                                          |
| 13-10-2026               | The fork, with that work as it stood then, is submitted to the Find Your Way hackathon.                                                                                                                                                                                                                                                                    |

So, before HackMeridian, the package had one node, the Stellar Signer.

## During the event

Everything below was built from 25-10-2026 at 09:00 Lisbon time. The design decisions behind it were
also taken that day, during the event.

### The Stellar node and the Stellar Trigger

The branch `core-nodes` starts from `8100935`. Its 20 commits add the **Stellar** node (Account,
Payment and Asset) and the **Stellar Trigger**:

| Time  | Commit    | What                                                                                 |
| ----- | --------- | ------------------------------------------------------------------------------------ |
| 13:55 | `a1d4aa3` | refactor(shared): move the horizon client and the node for errors to a shared module |
| 14:16 | `f54d7d0` | feat(stellar): add the stellar node with payment build in xlm                        |
| 14:27 | `1c2d116` | feat(stellar): check the destination before building a payment                       |
| 14:34 | `0459707` | refactor(stellar): run each operation over all the items of a run                    |
| 14:35 | `04f4f5c` | feat(stellar): give payments from one account consecutive sequence numbers           |
| 14:41 | `d807972` | feat(stellar): add payment get transaction                                           |
| 15:01 | `7df9467` | feat(trigger): add the stellar trigger with payment received                         |
| 15:59 | `1dd4625` | feat(stellar): build payments in issued assets and check the trustline               |
| 16:13 | `c000eee` | feat(stellar): add account get with balances and trustlines                          |
| 16:22 | `fdfe13b` | feat(stellar): add the spendable balance to account get                              |
| 16:32 | `be29eea` | feat(trigger): filter payment received by asset and minimum amount                   |
| 16:43 | `d36c46c` | refactor(stellar): share the payment fields and checks of build                      |
| 16:45 | `c569fff` | feat(stellar): add payment batch, many payments in one transaction                   |
| 16:49 | `f6d26f8` | refactor(stellar): read a received payment in the transport                          |
| 16:56 | `1ab1d0b` | feat(stellar): add payment check paid                                                |
| 17:06 | `0e6923a` | refactor(stellar): share the source account, asset and time limit readers            |
| 17:13 | `f6cc915` | feat(stellar): add asset build trustline                                             |
| 17:17 | `f759137` | refactor(stellar): read an account's balances in the transport                       |
| 17:26 | `39e9f62` | refactor(stellar): read an account and its balances in one transport call            |
| 17:30 | `ff7a8a3` | feat(trigger): add balance below threshold                                           |

### Confidential Token

The branch `confidential-token` starts from `core-nodes` and adds the **Confidential Token** node:

| Time  | Commit    | What                                                                         |
| ----- | --------- | ---------------------------------------------------------------------------- |
| 16:37 | `14cf930` | chore(confidential): copy the confidential token sdk at aad1706              |
| 16:47 | `cd5ce64` | chore(confidential): compile the copied sdk to commonjs in the package build |
| 20:37 | `71ff984` | merge core-nodes into confidential-token                                     |
| 20:41 | `14888e1` | refactor(shared): move the signer policy to the shared module                |
| 21:11 | `c07784f` | feat(confidential): add the encrypted state store and the account lock       |
| 21:14 | `88bfc63` | feat(shared): check confidential amounts and fees against the policy         |
| 21:19 | `db6a18c` | feat(confidential): classify rpc submissions like the signer                 |
| 21:26 | `53a0d1a` | feat(confidential): add the confidential token node with holder register     |

<!-- CT-STATUS: add the commits of Deposit, Merge, Get Balance, Transfer and Withdraw as they land. -->

Outside this repository, between 18:39 and 18:42 UTC, the project deployed its own set of
confidential token contracts on Testnet, in 31 transactions: a verifier, an auditor registry with an
auditor key of its own, a factory, and three tokens. [ARCHITECTURE.md](ARCHITECTURE.md) lists them.

### The demo, from n8n

- The supplier invoice workflow of [`examples/`](examples/) ran from n8n's engine on Testnet and
  paid invoice `INV-1001` (transaction
  `4d5f6d52c8b7fae8c81a2ee6dbacd33710313105287d4a5d51fb540dc48cac0a`, ledger 5387451). Its second
  run found the invoice paid and skipped it.
- The Confidential Token node registered a new account from n8n's engine on Testnet (transaction
  `bed12f3bbab810cc87a27b8da20d98269b862037bc1e61c954c855dfa74b5158`, ledger 5388060).

### Documentation

| Time  | Commit    | What                                                                    |
| ----- | --------- | ----------------------------------------------------------------------- |
| 21:43 | `7061161` | docs(package): add the demo workflows as examples                       |
| 21:43 | `10b8911` | docs(package): describe the four nodes, the demo and the testing status |
| 21:46 | `3143571` | docs(package): add the architecture, the deployment and the evidence    |

This file, `AGENTS.md` and later changes to the documents come after these.

## Where to look

- [README.md](README.md): the four nodes, installation, the demo, and the
  [testing status](README.md#testing-status).
- [ARCHITECTURE.md](ARCHITECTURE.md): the Stellar APIs, the contracts and the evidence on Testnet.
- `git log --since="2026-10-25T09:00"` on this repository lists every commit of the event.
