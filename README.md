# n8n-nodes-stellar

This is an n8n community node. It lets you sign Stellar transactions in your n8n workflows, with a
secret key stored in an n8n credential, and submit them to the network.

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

The package has one node, **Stellar Signer**. It signs a Stellar transaction and returns it signed.
It can also submit the signed transaction to the network, which is off by default.

Parameters:

- **Transaction XDR** (`xdr`): the unsigned transaction, as base64 XDR.
- **Network** (`network`): Public (`public`) or Testnet (`testnet`). The transaction is signed for
  this network.
- **Submit to Horizon** (`submit`): off by default. When it is on, the node submits the transaction
  it signed to the network through [Horizon](https://developers.stellar.org/docs/data/apis/horizon)
  and waits for the result. It submits once and doesn't retry.
- **Horizon URL** (`horizonUrl`): shown when **Submit to Horizon** is on, and empty by default. Set
  it to submit to another Horizon server, such as your own or a provider's. It must be an `https`
  address. It accepts an expression, so several nodes can share one address from a variable.

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

If Horizon doesn't confirm the transaction, the item fails.

## Credentials

The node uses the **Stellar Wallet API** credential (`stellarWalletApi`), which has one field,
**Secret Key** (`secretKey`). See [CREDENTIALS.md](CREDENTIALS.md) for what the secret key is, how
to get one on Testnet and how to keep it safe.

The secret key lives only in the credential. The node never returns it in its output or in its error
messages.

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
