# n8n-nodes-stellar

This is an n8n community node. It lets you sign Stellar transactions in your n8n workflows, with a
secret key stored in an n8n credential, and optionally submit them to the network. It can also sign
a message with that key.

[Stellar](https://stellar.org/) is a public blockchain network for payments and asset issuance. Its
native currency is the lumen (XLM).

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/n8n-community-license) workflow
automation platform.

[Installation](#installation)  
[Operations](#operations)  
[Credentials](#credentials)  
[Compatibility](#compatibility)  
[Usage](#usage)  
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in
the n8n community nodes documentation.

## Operations

The package has one node, **Stellar Signer**, with two operations:

- **Sign Transaction** (`signTransaction`), the default: signs a Stellar transaction and returns it
  signed. It can also submit the signed transaction to the network, which is off by default.
- **Sign Message** (`signMessage`): signs a text with the wallet's key. See
  [Sign a message](#sign-a-message).

A workflow saved before the **Operation** parameter existed signs transactions, as before.

### Sign a transaction

Parameters:

- **Transaction XDR** (`xdr`): the unsigned transaction, as base64 XDR.
- **Network** (`network`): Public (`public`) or Testnet (`testnet`). The transaction is signed for
  this network.
- **Submit to Horizon** (`submit`): off by default. When it is on, the node submits the transaction
  it signed to the network through [Horizon](https://developers.stellar.org/docs/data/apis/horizon)
  and waits for the result. It submits once and doesn't retry. If the value comes from an
  expression, it must be `true` or `false`: n8n fails the item for any other text.
- **Horizon URL** (`horizonUrl`): shown when **Submit to Horizon** is on, and empty by default. Set
  it to submit to another Horizon server, such as your own or a provider's. It must be an `https`
  address; plain `http` is accepted only for a server on `localhost`. It accepts an expression, so
  several nodes can share one address from a variable.

> **`testnet` is the default network.** To sign for the real network, choose **Public** in the
> **Network** parameter. On the public network, a signed transaction moves real funds once it is
> submitted, and with **Submit to Horizon** on the node submits it itself. Check the **Network**
> parameter before you run a workflow.

Each input item must have a `networkName` field with `public` or `testnet`, the network the
transaction was built for. The Stellar Signer signs only when that value is the same as the
**Network** parameter. If the field is missing, has another value or names the other network, that
item fails and isn't signed.

The network isn't stored in the transaction XDR, so this field is how the node knows which network
the transaction was built for. If the XDR comes from a node that doesn't set it, add the field with
an **Edit Fields** node before the Stellar Signer, with **Include Other Input Fields** turned on so
the item keeps the XDR.

Each output item keeps the fields of its input item and adds:

| Field         | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| `signedXdr`   | The signed transaction, as base64 XDR.                                                |
| `txHash`      | The transaction hash, in hex.                                                         |
| `publicKey`   | The public key of the account that signed, which matches the credential's secret key. |
| `network`     | The full network passphrase.                                                          |
| `networkName` | `public` or `testnet`.                                                                |

With **Submit to Horizon** on, the node sends the transaction to SDF's Horizon server for the chosen
network: `https://horizon-testnet.stellar.org` for `testnet` and `https://horizon.stellar.org` for
`public`. Stellar's documentation no longer lists the `public` one: if it stops answering, enter
your provider's address in **Horizon URL**. Each output item also has:

| Field       | Description                                             |
| ----------- | ------------------------------------------------------- |
| `submitted` | `true`: Horizon confirmed the transaction.              |
| `ledger`    | The number of the ledger that included the transaction. |

Before it signs a payment that has no memo, the node asks that Horizon server whether the
destination account requires one
([SEP-29](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0029.md)). If it
does, or if Horizon doesn't answer, the item fails and nothing is signed or sent.

The node waits up to 60 seconds for each answer from Horizon and doesn't follow redirects. Error
messages count a transaction's operations from 1 and a run's items from 0, as n8n does.

### When Horizon doesn't confirm a transaction

The node submits once. If Horizon doesn't confirm the transaction, the item fails, and the error
says which of these happened:

| Outcome         | What happened                                                                                                                                                                          | What to do                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `rejected`      | Horizon answered with result codes, such as `tx_failed` and `op_underfunded`.                                                                                                          | Fix what the codes say and build a new transaction. For `tx_bad_seq` and `tx_too_late`, look the transaction up first. |
| `not_submitted` | The transaction didn't reach the network. Horizon answered before it passed it on, for example with a rate limit, or the node didn't send it because an earlier item had the same one. | Do what the error's description says.                                                                                  |
| `uncertain`     | Horizon didn't say whether the transaction was applied: it timed out or answered with a server error, the connection failed, or the answer wasn't Horizon's.                           | Look the transaction up by its hash before anything else.                                                              |

An uncertain result doesn't mean the transaction failed. The network can still apply it until the
time limit it was built with, and the error gives that time. Look it up by its hash, for example at
`<Horizon URL>/transactions/<txHash>`.

Sending the same signed transaction again is safe, because the network applies a transaction only
once. There are two ways to do it:

- Run this node again with the same unsigned transaction. It signs it into the same signed
  transaction and submits it.
- Send `signedXdr` to Horizon yourself, for example with an **HTTP Request** node that posts it as
  the `tx` form field to `<Horizon URL>/transactions`.

Don't pass `signedXdr` through the Stellar Signer: it would sign it a second time, and the network
rejects a repeated signature.

What can pay twice is a **new** transaction for the same payment, which has another hash. Don't
build one until you know that the first wasn't applied.

Two result codes need that check too. Horizon can answer `tx_bad_seq` or `tx_too_late` to a
transaction that was sent before and applied, so the error for those says to look the transaction up
first. Their outcome is still `rejected`: a workflow that builds a new payment for every `rejected`
item should leave those two codes out.

Leave n8n's **Retry On Fail** setting off on this node while **Submit to Horizon** is on. A retry
runs the node again for all its items, also the ones whose transactions were already applied. That
can't pay twice, but Horizon may answer a transaction it already applied with `tx_bad_seq`, and the
retry then reports a rejection for a payment that was made.

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

### Several payments in one run

Each item is one transaction, and the node submits them one at a time, in order.

- With **On Error** on **Stop Workflow**, which is n8n's default, the first item that fails stops
  the run and n8n discards the output of the items before it, although their transactions were
  applied. The error says how many were applied and lists their hashes. Don't run the workflow again
  from the start after that: it would build new transactions and pay the applied ones a second time.
- To keep each item's result, set **On Error** to **Continue (using error output)**, or put the node
  inside a **Loop Over Items** node so it handles one item per run.
- An item with the same transaction as an earlier item of the run fails and isn't sent: a
  transaction is applied only once, so it pays once. Build a separate transaction for each payment.

### Sign a message

With **Operation** on **Sign Message**, the node signs the text of the **Message** parameter
(`message`) with the wallet's key, following
[SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md). It signs
the text exactly as it arrives, without trimming it. A text that is empty or has only spaces and
line breaks fails the item. The node doesn't need a `networkName` field in the item, and it sends
nothing to the network.

Each output item keeps the fields of its input item and adds:

| Field       | Description                                         |
| ----------- | --------------------------------------------------- |
| `message`   | The text that was signed.                           |
| `signature` | The signature, 64 bytes as base64.                  |
| `publicKey` | The public key of the account that signed the text. |

If the input item already has a field with one of these names, the node's value replaces it.

Anyone can check the signature with the Stellar SDK:
`Keypair.fromPublicKey(publicKey).verifyMessage(message, Buffer.from(signature, 'base64'))`.

Sign Message fails unless **Allow Message Signing** is on in the credential, and it is off by
default. A signed message proves that the wallet's key signed that text, and other services accept
such a proof, for example as a login. The node signs whatever text it receives, and n8n has no
screen that shows the text before it is signed. Don't sign a text that comes from outside the
workflow, such as a webhook or a form, without checking what it says first.

## Credentials

The node uses the **Stellar Wallet API** credential (`stellarWalletApi`). Its one required field is
**Secret Key** (`secretKey`). See [CREDENTIALS.md](CREDENTIALS.md) for what the secret key is, how
to get one on Testnet and how to keep it safe.

The secret key lives only in the credential. The node never returns it in its output or in its error
messages.

The credential can also limit what the node signs:

- **Allowed Operations** (`allowedOperations`): the operation types the node may sign, one per line,
  such as `payment`. A transaction with any other operation fails the item before it is signed.
- **Maximum Amounts** (`maxAmounts`): the most that one operation may send of each asset, one limit
  per line, as `XLM=100` or `CODE:ISSUER=100`, where `ISSUER` is the address of the account that
  issues the asset.
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
They don't apply to messages. A limit that the node can't read fails the whole run before anything
is signed. In n8n's Community edition, whoever can edit the workflow can also edit the credential,
so these limits guard against mistakes, not against that person. The limit that always holds is the
account: use one with only the funds the workflow needs.
[CREDENTIALS.md](CREDENTIALS.md#limit-what-the-node-signs) has the details.

## Compatibility

- Node.js 24 or later.
- The node depends on `@stellar/stellar-sdk` 17.1.0, which npm installs with the package.

## Usage

The Stellar Signer sits between a node that builds a transaction and a node that uses the signed
result:

1. A previous node produces the unsigned transaction XDR, in an item that has a `networkName` field
   with the network the transaction was built for.
2. In the Stellar Signer, set **Transaction XDR** with an expression that reads that XDR from the
   previous node's output, and choose the same network in **Network**.
3. The next node reads the signed transaction with `{{ $json.signedXdr }}`. To send it to the
   network from this node instead, turn on **Submit to Horizon** and read `{{ $json.ledger }}`.

Sign each transaction only once with the same key. If the same XDR goes through the Stellar Signer
twice with the same key, it carries a repeated signature, and the network rejects it with
`tx_bad_auth_extra`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Stellar transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions)
