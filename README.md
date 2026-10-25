# n8n-nodes-stellar

This is an n8n community node package for [Stellar](https://stellar.org/), a public blockchain
network for payments and asset issuance, whose native currency is the lumen (XLM). Its nodes let an
n8n workflow read Stellar accounts and payments, build payments, sign them with a key kept in an n8n
credential, submit them, and start when an account receives a payment.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/n8n-community-license) workflow
automation platform.

[What it does](#what-it-does)  
[Installation](#installation)  
[Environment variables](#environment-variables)  
[Try it without installing](#try-it-without-installing)  
[Run the demo](#run-the-demo)  
[Nodes](#nodes)  
[Credentials](#credentials)  
[Security notes](#security-notes)  
[Testing status](#testing-status)  
[Architecture and prior work](#architecture-and-prior-work)  
[Compatibility](#compatibility)  
[Resources](#resources)

## What it does

An n8n workflow can read an invoice or a payroll sheet, but paying it on Stellar takes several
steps: build the transaction, check it before it is signed, sign it with the account's secret key,
submit it, confirm the result, and avoid paying the same invoice twice. This package gives each of
those steps as an n8n node, so the whole payment runs inside the workflow, and the secret key stays
in an n8n credential that only the Stellar Signer reads.

| Node                   | What it does                                                                                                                                                                                 | Status          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **Stellar Signer**     | Signs a transaction with the credential's secret key, checks it first against limits set in the credential, and can submit it to the network. It can also sign a message (SEP-53).           | Built           |
| **Stellar**            | Reads an account's balances, builds unsigned payments (one per item, or many in one transaction), checks whether an invoice was already paid, looks a transaction up, and builds trustlines. | Built           |
| **Stellar Trigger**    | Starts the workflow when an account receives a payment, or when its balance goes below a threshold.                                                                                          | Built           |
| **Confidential Token** | Registers an account in a confidential token on Testnet: a token designed to keep balances and amounts private while addresses stay public.                                                  | **In progress** |

<!-- CT-STATUS: update this row and the Confidential Token sections when ticket #95 closes. -->

The Stellar node has no key and signs nothing. The Stellar Signer is the only node that reads the
Stellar Wallet API credential, so a workflow builds with the Stellar node, signs with the Signer,
and confirms with the Stellar node again.

## Installation

### From this repository (all four nodes)

The version published on npm, 0.2.0, has only the Stellar Signer. To install the four nodes, build
the package from this repository and install it into your self-hosted n8n:

```bash
git clone --branch confidential-token https://github.com/elitelephant/n8n-nodes-stellar.git
cd n8n-nodes-stellar
npm ci
npm run build
npm pack                       # writes n8n-nodes-stellar-<version>.tgz

mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-stellar-<version>.tgz
```

npm also installs the dependencies of the Confidential Token SDK, such as `@aztec/bb.js`, so it
takes longer than for the Signer alone. Then restart n8n. This follows n8n's
[manual installation](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/)
of community nodes, with the package file in place of a name on npm. In Docker, copy the package
file into the container and run the last three commands in its shell, as that page shows. Don't use
**Update** on n8n's community nodes screen for this package: it would install 0.2.0 from npm, which
has only the Signer.

### From npm (Stellar Signer only)

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in
the n8n community nodes documentation, with the package name `n8n-nodes-stellar`.

## Environment variables

The package reads no environment variables of its own. What each node needs is a parameter or a
credential field:

- The Stellar Signer, the Stellar node and the Stellar Trigger take an optional **Horizon URL**.
  Empty, they use SDF's Horizon server for the chosen network.
- The Confidential Token node takes an optional **RPC URL** and a **State Folder**, where it keeps
  each account's encrypted state and the setup file its proofs need. Empty, the folder is
  `~/.n8n/stellar-confidential`. See [Confidential Token](#confidential-token).

## Try it without installing

<!-- JUDGES-URL: the address of the public n8n instance for the HackMeridian judges goes here. -->

A public n8n instance with these nodes installed, for trying them without installing anything, is
being set up. Its address will be here.

## Run the demo

The [`examples/`](examples/) folder has the two workflows of the demo, on Testnet. They hold no
credentials, keys or account addresses.

1. Install the package as described above, and start n8n.
2. Create two Testnet accounts, a payer and a supplier, for example with the
   [Create Account Keypair](https://lab.stellar.org/account/create) page of Stellar Lab and its
   **Fund account with Friendbot** button, which gives each account 10,000 test XLM. See
   [CREDENTIALS.md](CREDENTIALS.md#get-a-secret-key-on-testnet).
3. In n8n, create a **Stellar Wallet API** credential with the payer's secret key.
4. Import [`examples/pay-supplier-invoice.json`](examples/pay-supplier-invoice.json) (**Import from
   File** in the workflow menu). In its **Invoice** node, replace
   `REPLACE_WITH_THE_PAYER_PUBLIC_KEY` and `REPLACE_WITH_THE_SUPPLIER_PUBLIC_KEY` with the two
   public keys. In the **Stellar Signer** node, choose the credential.
5. Run the workflow. It reads the payer's balances (**Account › Get**), checks whether invoice
   `INV-1001` was already paid to the supplier (**Payment › Check Paid**), builds a 25 XLM payment
   with the invoice number as its memo (**Payment › Build**), signs and submits it (**Stellar
   Signer**, with **Submit to Horizon** on), and looks it up on Horizon (**Payment › Get
   Transaction**). The Signer's output has `submitted: true` and the `ledger`.
6. Run it again. **Check Paid** now finds the payment, `paid` is `true`, and the workflow skips the
   invoice instead of paying it twice.

[`examples/supplier-payment-received.json`](examples/supplier-payment-received.json) is the
supplier's side: a **Stellar Trigger** that watches the supplier's account for payments received,
polling every minute. Replace `REPLACE_WITH_THE_SUPPLIER_PUBLIC_KEY` and publish the workflow, so
that, as n8n's [Save and publish workflows](https://docs.n8n.io/workflows/publish/) page puts it,
"events from connected apps will trigger this workflow". **Fetch Test Event** returns the last
payment the account received.

The demo's own run, from n8n's engine on Testnet, is listed in
[ARCHITECTURE.md](ARCHITECTURE.md#evidence-on-testnet).

## Nodes

### Stellar Signer

The **Stellar Signer** has two operations:

- **Sign Transaction** (`signTransaction`), the default: signs a Stellar transaction and returns it
  signed. It can also submit the signed transaction to the network, which is off by default.
- **Sign Message** (`signMessage`): signs a text with the wallet's key. See
  [Sign a message](#sign-a-message).

A workflow saved before the **Operation** parameter existed signs transactions, once its input items
carry `networkName`, as explained below.

#### Sign a transaction

Parameters:

- **Transaction XDR** (`xdr`): the transaction to sign, as base64 XDR. It can already carry other
  signers' signatures, to co-sign it (see [Usage](#usage)).
- **Network** (`network`): Public (`public`) or Testnet (`testnet`). The transaction is signed for
  this network.
- **Submit to Horizon** (`submit`): off by default. When it is on, the node submits the transaction
  it signed to the network through [Horizon](https://developers.stellar.org/docs/data/apis/horizon)
  and waits for the result. It submits once and doesn't retry. If the value comes from an
  expression, it must be `true` or `false`: n8n fails the item for any other text.
- **Horizon URL** (`horizonUrl`): shown when **Submit to Horizon** is on, and empty by default. Set
  it to submit to another Horizon server, such as your own or a provider's. It must be an `https`
  address; plain `http` is accepted only for a server on `localhost`. It can't include a user name
  or a password. It accepts an expression, so several nodes can share one address from a variable. A
  provider's address can carry a key, so the node keeps it out of the errors that n8n stores and
  sends to an error workflow: they name only the server. n8n itself stores the address in the
  workflow as you wrote it.

> **`public` is the default network.** On the public network, a signed transaction moves real funds
> once it is submitted, and with **Submit to Horizon** on the node submits it itself. To try a
> workflow without real funds, choose **Testnet** in the **Network** parameter. Check the
> **Network** parameter before you run a workflow. Workflows saved with the 0.1.1 value `mainnet`
> sign for the public network once their items carry `networkName` set to `public`, as described
> below.

Each input item must have a `networkName` field with `public` or `testnet`, the network the
transaction was built for. The Stellar Signer signs only when that value is the same as the
**Network** parameter. If the field is missing, has another value or names the other network, that
item fails and isn't signed.

The network isn't stored in the transaction XDR, so this field is how the node knows which network
the transaction was built for. If the XDR comes from a node that doesn't set it, add the field with
an **Edit Fields** node before the Stellar Signer, with **Include Other Input Fields** turned on so
the item keeps the XDR. The Stellar node sets it on every item it outputs.

Each output item keeps the fields of its input item and adds:

| Field         | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| `signedXdr`   | The signed transaction, as base64 XDR.                              |
| `txHash`      | The transaction hash, in hex.                                       |
| `publicKey`   | The public key of the credential's secret key, the key that signed. |
| `network`     | The full network passphrase.                                        |
| `networkName` | `public` or `testnet`.                                              |

With **Submit to Horizon** on, the node sends the transaction to SDF's Horizon server for the chosen
network: `https://horizon-testnet.stellar.org` for `testnet` and `https://horizon.stellar.org` for
`public`. Stellar's Horizon page names SDF's `testnet` server but not the `public` one: if it stops
answering, enter your provider's address in **Horizon URL**. Each output item also has:

| Field       | Description                                             |
| ----------- | ------------------------------------------------------- |
| `submitted` | `true`: Horizon confirmed the transaction.              |
| `ledger`    | The number of the ledger that included the transaction. |

Before it signs a transaction without a memo that pays a `G` address with a payment, a path payment
or an account merge, the node asks that Horizon server whether the destination account requires a
memo ([SEP-29](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0029.md)). If
it does, or if Horizon doesn't answer or answers with an error, the item fails and nothing is signed
or sent. A destination account that doesn't exist yet requires nothing.

The node waits up to 60 seconds for each answer from Horizon and doesn't follow redirects. Error
messages count a transaction's operations from 1 and a run's items from 0, as n8n does.

#### When Horizon doesn't confirm a transaction

The node submits once. When Horizon gives no verdict, the node looks the transaction up by its hash
on the same Horizon server: at once, and then every 5 seconds for up to 30 seconds. If the
transaction is there, the item comes out as submitted, with its ledger, or as `rejected` if the
network included it as failed. If Horizon doesn't confirm the transaction, the item fails, and the
error says which of these happened:

| Outcome         | What happened                                                                                                                                                                                                                                                     | What to do                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejected`      | Horizon answered with result codes, such as `tx_failed` and `op_underfunded`, or the node found the transaction in a ledger as failed.                                                                                                                            | Do what the error's description says. Some codes, explained below, let this same signed transaction in later: then don't also build a new one. For `tx_too_late`, check first that the payment wasn't already made. |
| `not_submitted` | The transaction didn't reach the network. Horizon answered with one of the errors it gives before it passes a transaction on, for example a rate limit, or the node didn't send it because an earlier item had the same one.                                      | Do what the error's description says.                                                                                                                                                                               |
| `uncertain`     | Horizon gave no final answer, and the node didn't find the transaction when it looked it up: Horizon timed out or answered with a server error, the connection failed, the answer wasn't one of Horizon's, or Horizon rejected the transaction with `tx_bad_seq`. | Send the same signed transaction again until Horizon gives a final result, and look it up by its hash. For `tx_bad_seq`, compare sequence numbers, as explained below.                                              |

An uncertain result doesn't mean the transaction failed. Unless the error says `tx_bad_seq`, which
is explained below, the network can still apply the transaction until the limit it was built with,
and the error gives it: a time, a ledger number, or both. Look it up by its hash, for example at
`<Horizon URL>/transactions/<txHash>`. The node already looked for it there, for up to 30 seconds,
and the error says whether it didn't find it or couldn't look. Not finding a transaction on a
Horizon server doesn't prove that it wasn't applied: a server can be set up to keep only some
transactions, or only recent ones. After that limit, the account's sequence number settles it: if it
is lower than the transaction's, the transaction was not applied. The error gives the transaction's
number.

Only Horizon's own errors count as `not_submitted`. An error from another server, such as a 401 from
a provider that didn't accept its key, comes out as `uncertain`, and its description says to check
**Horizon URL**.

Sending the same signed transaction again is safe, because the network applies a transaction only
once. After an uncertain result, Stellar's documentation advises sending it again until Horizon
gives a final result or the time limit passes, because the network may have dropped it from its
queue. There are two ways to do it:

- Run this node again with the same unsigned transaction. It signs it into the same signed
  transaction and submits it.
- Send `signedXdr` to Horizon yourself, for example with an **HTTP Request** node that posts it as
  the `tx` form field to `<Horizon URL>/transactions`.

Passing `signedXdr` through a Stellar Signer with the same credential fails the item before it is
signed: a second signature of the same key makes the network reject the transaction. Use one of the
two ways above.

What can pay twice is a **new** transaction for the same payment, which has another hash. Don't
build one until you know that the first wasn't applied.

The result code `tx_bad_seq` is uncertain too. Every account numbers its transactions, and Horizon
answers `tx_bad_seq` when a transaction's number isn't the next one for its account. That has two
meanings, and Horizon's answer doesn't say which. Compare the account's sequence number, at
`<Horizon URL>/accounts/<account>`, with the transaction's. If the account's number is lower, the
transaction is ahead: it can still be applied if it is sent again once the account gets to the
number before it, until its limit. If the account's number is equal or higher, the account already
used that number and this transaction can't be applied anymore. The transaction that used it may be
the same payment built twice: the account's last transactions are at
`<Horizon URL>/accounts/<account>/transactions`.

The result code `tx_too_late` is a rejection: the transaction's time limit or ledger limit passed,
or is seconds away, and the network no longer takes it. After `tx_bad_seq` or `tx_too_late`, check
that the payment wasn't already made before you build a new transaction.

The result codes `tx_insufficient_fee` and `tx_too_early` are rejections that the same signed
transaction can get past later: when the network asks for a lower fee, or when its start time or
first ledger comes. Send that same transaction again later or build a new one, but not both: if the
two are applied, the payment is made twice. For `tx_insufficient_fee` there is a third way: wrap the
same signed transaction in a fee bump transaction with a higher fee. A fee bump is built and signed
outside this node, for example with the Stellar SDK, by the account that pays the fee. It doesn't
sign the inner transaction again or change its sequence number, so, like sending it again, it can't
pay twice, and it works only while the inner transaction is within its limits.

The result codes `tx_insufficient_balance` and `tx_bad_minseq_age_or_gap` (which the Stellar SDK
writes `tx_bad_min_seq_age_or_gap`) are rejections that the same signed transaction can get past
too. The first means that the account can't pay the fee without going below its minimum balance:
send the account XLM and send the same transaction again, or wrap it in a fee bump paid by another
account. The second means that the transaction asks for a minimum time or number of ledgers after
its account's sequence number last changed: send it again once that has passed. Don't build a new
transaction for the same payment while this one can still be applied.

The result code `tx_bad_auth` is a rejection for the signatures. When an account of the transaction
needs more signature weight than the transaction carries, the same signed transaction can still be
applied: pass `signedXdr` through a Stellar Signer with the credential of another signer of the
account, and submit it. The code also comes from a key that isn't a signer of that account, or from
signatures made for another network than the Horizon server's, and then only a new transaction
helps. Do one or the other, never both. `tx_bad_auth_extra` means that the transaction carries a
signature the account doesn't use: a key signed it twice, a key that is no longer a signer signed
it, or it has more signatures than the account's threshold needs. Sign the same unsigned transaction
again with only the keys it needs: it keeps its hash, so it can't pay twice.

A `tx_failed` transaction may have been included in a ledger as failed. Then its fee was charged,
its sequence number was used, and Horizon has it under its hash.

Leave n8n's **Retry On Fail** setting off on this node while **Submit to Horizon** is on. A retry
runs the node again for all its items, also the ones whose transactions were already applied, and
sends every transaction again. That can't pay twice: Horizon answers a transaction that it already
applied, and still has in its history, with the first result.

With the node's **On Error** setting on one of the **Continue** options, an item that fails after it
was signed has an `error` object with what you need to follow it up:

| Field               | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `error.message`     | What happened.                                               |
| `error.description` | What to do next.                                             |
| `error.outcome`     | `rejected`, `not_submitted` or `uncertain`.                  |
| `error.txHash`      | The transaction hash, to look it up.                         |
| `error.signedXdr`   | The signed transaction, to send it again as described above. |

With **Continue**, that item has only the `error` object. With **Continue (using error output)**, it
also keeps the fields of its input item. An item that fails before it is signed, for example for a
wrong `networkName`, has `error` as a text with the message, as in other n8n nodes.

If the node can't use the credential at all, nothing is signed. That happens when n8n can't hand the
credential over, when the secret key is empty, or when one of the credential's limits can't be read.
With **On Error** on **Stop Workflow**, the run fails. With one of the **Continue** options, every
item comes out failed instead of going on unsigned. Each has `error` as a text with that same
message, without the fields of its input item, and the execution finishes as successful.

#### Several payments in one run

Each item is one transaction, and the node submits them one at a time, in order.

- With **On Error** on **Stop Workflow**, which is n8n's default, the first item that fails stops
  the run and n8n discards the output of the items before it, although their transactions were
  applied. The error says how many were applied and lists their hashes. Don't run the workflow again
  from the start after that: it would build new transactions and pay the applied ones a second time.
- To keep each item's result, set **On Error** to **Continue (using error output)**, or put the node
  inside a **Loop Over Items** node so it handles one item per run.
- An item with the same transaction as an earlier item of the run fails and isn't sent: a
  transaction is applied only once, so it pays once. Build a separate transaction for each payment.

#### Sign a message

With **Operation** on **Sign Message**, the node signs the text of the **Message** parameter
(`message`) with the wallet's key, following
[SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md). It signs
the text exactly as it arrives, without trimming it. A text that is empty or has only spaces and
line breaks fails the item. The node doesn't need a `networkName` field in the item, and it sends
nothing to the network.

Each output item keeps the fields of its input item and adds:

| Field       | Description                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `message`   | The text that was signed.                                                                                           |
| `signature` | The signature, 64 bytes as base64.                                                                                  |
| `publicKey` | The public key of the credential's secret key, the key that signed the text. It identifies the key, not an account. |

If the input item already has a field with one of these names, the node's value replaces it.

Anyone can check the signature with the Stellar SDK:
`Keypair.fromPublicKey(publicKey).verifyMessage(message, Buffer.from(signature, 'base64'))`.

Sign Message fails unless **Allow Message Signing** is on in the credential, and it is off by
default. A signed message proves that the wallet's key signed that text, and other services accept
such a proof, for example as a login. The node signs whatever text it receives, and n8n has no
screen that shows the text before it is signed. Don't sign a text that comes from outside the
workflow, such as a webhook or a form, without checking what it says first.

#### Usage

The Stellar Signer sits between a node that builds a transaction and a node that uses the signed
result:

1. A previous node produces the unsigned transaction XDR, in an item that has a `networkName` field
   with the network the transaction was built for. The Stellar node's **Payment › Build**, **Payment
   › Batch** and **Asset › Build Trustline** do both.
2. In the Stellar Signer, set **Transaction XDR** with an expression that reads that XDR from the
   previous node's output, and choose the same network in **Network**.
3. The next node reads the signed transaction with `{{ $json.signedXdr }}`. To send it to the
   network from this node instead, turn on **Submit to Horizon** and read `{{ $json.ledger }}`.

To co-sign a transaction that needs several signatures, because its account needs them or because an
operation has another source account, pass `signedXdr` through another Stellar Signer with the
credential of the next signer. Each key signs once: if the XDR already has a valid signature of the
credential's key, the item fails before it is signed, because the network rejects a repeated
signature with `tx_bad_auth_extra`. The network also rejects a signature that the account doesn't
need: once the signatures reach the account's threshold, one more, even a valid one, gets
`tx_bad_auth_extra`.

### Stellar

The **Stellar** node reads from Horizon and builds unsigned transactions for the Stellar Signer. It
has no credential and signs nothing.

Every operation has these parameters:

- **Network** (`network`): Public (`public`), the default, or Testnet (`testnet`). Every output item
  has it in its `networkName` field, which the Stellar Signer checks.
- **Horizon URL** (`horizonUrl`): optional, with the same rules as in the Stellar Signer. Empty, the
  node uses `https://horizon-testnet.stellar.org` for `testnet` and `https://horizon.stellar.org`
  for `public`.

Assets are written as in the Signer's credential: `XLM` or `native` for lumens, and `CODE:ISSUER`
for an issued asset. Amounts have up to 7 decimals. With n8n's **On Error** on a **Continue**
option, an item that fails comes out with its error and the next item runs.

#### Account › Get

Reads an account: its balance of each asset and what it can spend of it.

- **Account** (`account`): a `G` address, or an `M` (muxed) address, which stands for its `G`
  account.

Output:

| Field            | Description                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`        | The `G` address.                                                                                                                                                                                                                                                                  |
| `balances`       | One entry per asset, XLM first: `asset`, `balance`, `spendable` and the trustline's `limit` (`null` for XLM). `spendable` is the balance minus what the account's sell offers commit and, for XLM, minus the minimum balance, never below 0. Liquidity pool shares aren't listed. |
| `minimumBalance` | The XLM the account has to keep.                                                                                                                                                                                                                                                  |
| `baseReserve`    | The network's base reserve in the last ledger.                                                                                                                                                                                                                                    |
| `subentryCount`  | The account's subentries, such as trustlines and offers.                                                                                                                                                                                                                          |
| `sequence`       | The account's sequence number.                                                                                                                                                                                                                                                    |

The minimum balance is two base reserves, plus one for each subentry, adjusted for the entries the
account sponsors or that another account sponsors for it, as Stellar's documentation on
[minimum balance](https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance)
explains.

#### Payment › Build

Builds one unsigned payment per input item.

- **Source Account** (`sourceAccount`): the `G` address that pays. Its key signs the transaction in
  the Stellar Signer.
- **Destination** (`destination`): a `G` address, or the `M` address of one of its users.
- **Asset** (`asset`): `XLM` by default.
- **Amount** (`amount`).
- **Memo** (`memo`): optional text of up to 28 bytes, such as the invoice number the receiver uses
  to match the payment.
- **Time Limit (Seconds)** (`timeLimit`): how long the network accepts the transaction after it is
  built, counted on Horizon's clock. 300 by default.

Before it builds the payment, the node checks on Horizon that the destination account exists, that
it can receive the asset (it has a trustline for it, or it is its issuer), and that it has a memo if
the destination asks for one with SEP-29. A payment that fails a check isn't built. The fee is the
network's base fee, read from Horizon. Payments from the same source account in one run take
consecutive sequence numbers, in the order of the items, so the Stellar Signer can submit them all
in that order.

Output: `xdr`, `txHash`, `sourceAccount`, `sequence`, `fee`, `memo`, `networkName`,
`destinationExists`, `memoRequired` and `hasTrustline`.

#### Payment › Batch

Builds one unsigned transaction with a payment for each input item, such as a payroll run. The
**Source Account**, **Memo** and **Time Limit** come from the first item, and each item gives its
own **Destination**, **Asset** and **Amount**. A Stellar transaction holds up to 100 operations, so
a batch holds up to 100 payments. The transaction applies all its payments or none, so if one item
can't go in, nothing is built, and the error names every item that can't. Each destination gets the
same checks as in **Build**.

Output: a single item, linked to every input item, with `xdr`, `txHash`, `sourceAccount`,
`sequence`, `fee` (the base fee times the payments), `memo`, `paymentCount` and `networkName`.

#### Payment › Check Paid

Checks whether a payment already reached the destination, so that a workflow doesn't pay the same
invoice twice.

- **Destination** (`destination`): the account that would have received it. With an `M` address,
  only a payment to that same `M` address counts.
- **Memo** (`memo`): required, such as the invoice number.
- **Asset** (`asset`) and **Amount** (`amount`): only the exact amount counts.
- **Source Account** (`sourceAccount`): optional. Only payments from this account count.
- **Max Records** (`maxRecords`): how many of the destination's latest payment records to look
  through, from the newest. 200 by default.

Output: `paid`, and, when it is `true`, the payment's `txHash`, `ledger` and `createdAt`.
`searchedUntil` is the date of the oldest record it looked at: `paid: false` means the payment isn't
among those records, not that it was never made. A batch carries the memo of its run, not of each
invoice.

#### Payment › Get Transaction

Looks a transaction up on Horizon by its hash (`txHash`, 64 hexadecimal characters), such as the
`txHash` of the Stellar Signer's output.

Output: `txHash`, `successful`, `ledger`, `createdAt`, `memo`, `feeCharged` and `sourceAccount`. If
Horizon doesn't have the transaction, the item fails. That doesn't prove that it wasn't applied: a
Horizon server keeps only part of the history.

#### Asset › Build Trustline

Builds one unsigned change trust (`changeTrust`) per item, so an account can hold an issued asset
such as USDC.

- **Account** (`account`): the `G` address that will hold the asset.
- **Asset** (`asset`): `CODE:ISSUER`. XLM needs no trustline.
- **Trust Limit** (`trustLimit`): optional. Empty, the most Stellar allows.
- **Time Limit (Seconds)** (`timeLimit`): 300 by default.

Each new trustline is a subentry, so it raises the account's minimum balance by one base reserve. If
the Stellar Signer's credential limits amounts, assets or destinations, the Signer signs only
payments: list `changeTrust` in its **Allowed Operations**, together with the payment types it
should sign.

Output: `xdr`, `txHash`, `sourceAccount`, `sequence`, `fee`, `asset`, `limit` and `networkName`.

### Stellar Trigger

The **Stellar Trigger** polls Horizon and starts the workflow on one of two events (**Trigger On**,
`event`):

- **Payment Received** (`paymentReceived`), the default: a payment or a path payment to the account,
  or the create account operation that creates it.
- **Balance Below Threshold** (`balanceBelowThreshold`): the account's balance of an asset goes
  below a threshold.

Parameters:

- **Account** (`account`): the `G` address to watch.
- **Network** (`network`): Public (`public`), the default, or Testnet (`testnet`).
- **Horizon URL** (`horizonUrl`): optional, with the same rules as in the other nodes.
- For **Payment Received**, **Filters**: **Asset** (only payments in this asset) and **Minimum
  Amount** (only payments of at least this amount, to ignore spam).
- For **Balance Below Threshold**: **Asset** (`XLM` by default), **Threshold**, and **Compare
  With**: **Spendable Balance** (the default, what the account can send) or **Balance** (the whole
  balance).

**Payment Received** starts from the moment the workflow is published, without the account's
history. Each poll reads up to 10 pages of 200 records and leaves the rest for the next poll. Each
payment is one output item, with `from`, `to`, `asset`, `amount`, `memo`, `txHash`, `ledger`,
`createdAt` and `networkName`. **Fetch Test Event** returns the last payment the account received
that passes the filters, among its latest 200 payment records.

**Balance Below Threshold** fires once when the balance goes below the threshold, and again only
after the balance gets back to the threshold. The first poll fires if the balance is already below.
The output item has `account`, `asset`, `balance`, `spendable`, `threshold`, `compareWith` and
`networkName`. **Fetch Test Event** returns the balance when it is below the threshold, and fails
with the balance and the threshold when it isn't. An account without a trustline for the asset fails
the poll.

### Confidential Token

**In progress.**

<!-- CT-STATUS: this section describes the node as of commit 53a0d1a (Register). Update it when
tickets #94 and #95 close. -->

[Confidential tokens](https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens)
"let users keep token balances and transaction amounts private while keeping the sender and
receiver's addresses publicly visible onchain". OpenZeppelin implements them for Stellar in its
`stellar-contracts` library, as of v0.8.0. The same page warns: "The current verifier accepts only
non-zero-knowledge UltraHonk proofs, so OpenZeppelin does not guarantee that proofs keep balances
and amounts private." The node works only on Testnet.

The **Confidential Token** node has one resource, **Holder**. Its operation **Register** registers
the holder's account in a confidential token. **Deposit**, **Merge** and **Get Balance**, and then
**Transfer** and **Withdraw**, are being built.

Parameters:

- **Network** (`network`): only Testnet.
- **RPC URL** (`rpcUrl`): optional, with the rules of **Horizon URL**. Empty, the node uses SDF's
  Testnet RPC, `https://soroban-testnet.stellar.org`.
- **Token Contract** (`confidentialContract`), **Verifier Contract** (`verifierContract`) and
  **Auditor Contract** (`auditorContract`): the contracts' `C` addresses, required and without a
  default, so that the node never works on a deployment the user didn't choose.
- **State Folder** (`stateFolder`): where the node keeps each account's encrypted state and the
  setup file its proofs need. Empty, `~/.n8n/stellar-confidential`. Keep it: the RPC keeps contract
  events for 7 days at most, as Stellar's
  [events guide](https://developers.stellar.org/docs/build/guides/events/ingest) says, and without
  the saved state the node can't spend funds whose events are older.
- **Threads** (`threads`): how many threads proof generation uses. 1 by default.

**Register** adds **Auditor ID** (`auditorId`, 0 by default): the auditor, in the token's auditor
registry, that can read the account's amounts. It is chosen when the account registers and can't be
changed later. Its output has `account`, `token`, `registered`, `alreadyRegistered`, `txHash`,
`ledger`, `syncedLedger` and `networkName`. An account that is already registered with the same key
isn't registered again: nothing is sent, and `alreadyRegistered` is `true`. An account registered
with another key fails the item. The tokens of the demo deployment are compliant tokens with an
allowlist: the demo registers only accounts that the token's administrator allowed first.

The node makes its proofs inside the n8n installation, with the copy of the Stellar Confidential
Token SDK in `vendor/` ([VENDORED.md](vendor/stellar-confidential-token-sdk/VENDORED.md)). Before
the first proof, it downloads the CRS, the setup file of the proofs, from `crs.aztec.network` into
the state folder, so the first run takes longer. It submits through the RPC and judges each
submission as the Stellar Signer does: `rejected`, `not_submitted` or `uncertain`. It needs a
self-hosted n8n with disk access.

## Credentials

### Stellar Wallet API

The Stellar Signer uses the **Stellar Wallet API** credential (`stellarWalletApi`). Its one required
field is **Secret Key** (`secretKey`). See [CREDENTIALS.md](CREDENTIALS.md) for what the secret key
is, how to get one on Testnet and how to keep it safe.

The secret key lives only in the credential. The node never returns it in its output or in its error
messages.

The credential can also limit what the node signs:

- **Allowed Operations** (`allowedOperations`): the operation types the node may sign, one per line,
  such as `payment`. A transaction with any other operation fails the item before it is signed. With
  `invokeHostFunction` in the list, the node signs Soroban contract calls without looking at what
  they do, and its signature can authorize the call, such as a token allowance that outlasts the
  run.
- **Maximum Amounts** (`maxAmounts`): the most that one operation may send of each asset, one limit
  per line, as `XLM=100` or `CODE:ISSUER=100`, where `ISSUER` is the address of the account that
  issues the asset. `XLM` can also be written `native`. While it has any line, an operation that
  sends an asset without a line fails.
- **Allowed Assets** (`allowedAssets`): the assets the node may pay in, one per line, written the
  same way. A path payment needs the asset it sends and the asset it delivers.
- **Allowed Destinations** (`allowedDestinations`): the addresses the node may pay, one per line. A
  `G` address also allows its muxed (`M`) addresses.
- **Maximum Fee** (`maxFee`): the highest fee that a transaction may carry, in stroops: 1 XLM is
  10,000,000 stroops. `0`, the default, means no limit.
- **Allow Message Signing** (`allowMessageSigning`): off by default. **Sign Message** fails unless
  it is on.

While **Maximum Amounts**, **Allowed Assets** or **Allowed Destinations** is set, the node signs
only the four payment operations (`payment`, `pathPaymentStrictSend`, `pathPaymentStrictReceive` and
`createAccount`), unless **Allowed Operations** lists other types.

The limits on transactions are optional: an empty limit, or a **Maximum Fee** of 0, means no limit.
They don't apply to messages. A limit that the node can't read stops every item before anything is
signed: the run fails, or, with **On Error** on one of the **Continue** options, every item comes
out failed. In n8n's Community edition, whoever can edit the workflow can also edit the credential,
so these limits guard against mistakes, not against that person. The limit that always holds is the
account: use one with only the funds the workflow needs.
[CREDENTIALS.md](CREDENTIALS.md#limit-what-the-node-signs) has the details.

### Confidential Token Holder API

**In progress.**

The Confidential Token node uses the **Confidential Token Holder API** credential
(`confidentialTokenHolderApi`). Its **Secret Key** is the holder's Stellar secret key, and it gives
full access: whoever has it controls the account, and can see and spend its confidential balance.
Its limits are written as in the Stellar Wallet API credential: **Maximum Amounts** and **Allowed
Destinations**, checked on the amount before the node makes the proof, and **Maximum Fee**, checked
on the total fee after the node simulates the transaction and before it signs it. Their error texts
don't show amounts. The node applies these limits from Transfer and Withdraw on.

## Security notes

- **Maximum Amounts is per payment.** The Signer compares each payment operation with its limit on
  its own, and there is no limit per transaction or per run. A **Payment › Batch** of payments that
  are each under the limit is signed whole, and so are ten separate payments of 10 under a limit
  of 10. To cap a run, keep only what it needs in the account.
- **Execution data.** n8n's execution history keeps the input and output of each node. By default,
  n8n saves the data of every execution, successful, failed or started by hand
  ([execution variables](https://docs.n8n.io/hosting/configuration/environment-variables/executions/)).
  For these nodes that data includes addresses and amounts, and, for the Confidential Token node,
  the amounts and balances it decrypts. These nodes don't ask you to stop saving executions: without
  the history, you can't see whether a workflow worked. Keep in mind who can read it:
  - On n8n Enterprise (Cloud or self-hosted), from n8n 2.16.0, turn on the workflow settings
    **Redact production execution data** and **Redact manual execution data** in the workflows that
    use the Confidential Token node
    ([Redact execution data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/redact-execution-data/)).
    Redaction exists only on Enterprise. The same page warns that redaction is "not a backend access
    control" and that it "doesn't encrypt or change execution data in the database": anyone with
    direct access to the database can still read the data.
  - On other editions, the data stays in the executions as n8n saved it.
- **Confidential Token privacy.** Stellar's documentation warns that the current verifier doesn't
  guarantee that balances and amounts stay private: see the quote in
  [Confidential Token](#confidential-token).
- **Keys.** Each secret key lives in its own credential and only one node reads it. Use a separate
  account for each workflow, with only the funds it needs, and try workflows on Testnet first.

## Testing status

This section says plainly what was tested and what wasn't, as of 25-10-2026.

- **Up to commit `14888e1`** (the Stellar Signer, the Stellar node, the Stellar Trigger, and the
  copy of the Confidential Token SDK), the package has an automated suite of 879 tests with
  `node:test`, kept outside this repository. It loads the compiled package with a fake n8n context,
  and the submission tests use a local fake Horizon. 867 run by default; 11 more run on request
  (real runs on Testnet, and waits of 60 seconds), and one waits for a text that isn't written yet.
- **After `14888e1`**, the Confidential Token work is tested only end to end on Testnet, by choice:
  the only tests added to the suite are opt-in runs on Testnet, and no local tests were added before
  26-10-2026. Its encrypted state, account lock, policy and RPC submission were also checked with
  scripts. The Testnet transactions are in [ARCHITECTURE.md](ARCHITECTURE.md#evidence-on-testnet).
  <!-- CT-STATUS: add the end-to-end Testnet results of Register, Deposit, Merge, Get Balance,
  Transfer and Withdraw here as tickets #93-#95 close. -->
- **Not tested yet:** the RPC answers that can't be caused on request (`TRY_AGAIN_LATER`,
  `DUPLICATE`, a transaction that stays pending, a failed one, an RPC that times out), which were
  checked only with made-up answers; the rules for **RPC URL**; an automated check that no
  Confidential Token error carries a secret; two Confidential Token runs at the same time inside n8n
  (the account lock was checked only with two calls in one process); and restoring an archived
  account. The local tests for all of this come after HackMeridian 2026, in ticket #104 of the
  project's own tracker.
- **In n8n itself:** the demo payment and a Confidential Token **Register** ran from n8n's engine on
  Testnet, from the command line, not on n8n's screen. The Stellar Trigger is tested with the test
  harness, but it wasn't seen polling inside n8n.
- **Public network:** no real payment on the public network was tested.

## Architecture and prior work

- [ARCHITECTURE.md](ARCHITECTURE.md): which Stellar APIs each node uses, the operations and assets,
  the contracts of the Confidential Token deployment on Testnet, and the transactions that prove the
  demo ran.
- [HACKMERIDIAN.md](HACKMERIDIAN.md): what existed before HackMeridian 2026, and what was built
  during the event, commit by commit.

## Compatibility

- Node.js 24 or later.
- Tested with n8n 2.25.6, self-hosted.
- The nodes depend on `@stellar/stellar-sdk` 17.1.0, which npm installs with the package. The copy
  of the Confidential Token SDK uses `@stellar/stellar-sdk` 14.6.1, installed under the name
  `stellar-sdk-14`, and `@aztec/bb.js` 0.87.0 for its proofs.
- Not eligible for n8n Cloud: the package has runtime dependencies, and the Confidential Token node
  needs disk access.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Stellar transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions)
- [Stellar privacy: confidential tokens](https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens)
