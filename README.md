# n8n-nodes-stellar

This is an n8n community node. It lets you sign Stellar transactions in your n8n workflows, with a
secret key stored in an n8n credential.

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
It doesn't submit the transaction to the network.

Parameters:

- **Transaction XDR** (`xdr`): the unsigned transaction, as base64 XDR.
- **Network** (`network`): Public (`public`) or Testnet (`testnet`). The transaction is signed for
  this network.

> **`public` is the default network.** On the public network, a signed transaction moves real funds
> once it is submitted. Check the **Network** parameter before you run a workflow. Try it on
> `testnet` first.

Each output item keeps the fields of its input item and adds:

| Field         | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| `signedXdr`   | The signed transaction, as base64 XDR.                                                |
| `txHash`      | The transaction hash, in hex.                                                         |
| `publicKey`   | The public key of the account that signed, which matches the credential's secret key. |
| `network`     | The full network passphrase.                                                          |
| `networkName` | `public` or `testnet`.                                                                |

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

1. A previous node produces the unsigned transaction XDR.
2. In the Stellar Signer, set **Transaction XDR** with an expression that reads that XDR from the
   previous node's output.
3. The next node reads the signed transaction with `{{ $json.signedXdr }}`.

Sign each transaction only once with the same key. If the same XDR goes through the Stellar Signer
twice with the same key, it carries a repeated signature, and the network rejects it with
`tx_bad_auth_extra`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Stellar transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions)
