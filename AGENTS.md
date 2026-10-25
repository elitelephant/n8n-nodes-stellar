# n8n community node

## Overview

This is a project containing code for an n8n community node. n8n is a workflow automation platform
where users build workflows with nodes, which are the building block of a workflow. Nodes can
perform a range of actions, such as starting a workflow (called a "trigger node"), fetching and
sending data, or processing and manipulating it. Besides that there are credentials - entities that
store sensitive information on how to connect to external services and APIs. A node can require some
credentials to be used. Community nodes are a way for anyone to create such nodes and add them to be
used in n8n. All community nodes are named in a format: `n8n-nodes-<n>` or `@org/n8n-nodes-<n>`.
Community nodes can also be submitted for approval to be used on n8n Cloud version. In that case
there are rules that the node needs to follow in order to be approved. This package is not eligible
for n8n Cloud: it has a runtime dependency (`@stellar/stellar-sdk`) and its own ESLint config, so
don't plan for a Cloud submission.

## Important notes

- Follow the **rules and guidelines in this document and the linked docs below** over any code
  examples.
- All code blocks in these docs are **illustrative and incomplete**. They **MUST NOT** be copied
  verbatim or assumed to be the final desired code.
- Replace example names like `Example`, `Wordpress`, `wordpressApi`, etc. with names that match the
  **actual service / node** you are building.
- When in doubt, **generalize from the patterns**, don't replicate the exact structure, fields, or
  values from the examples.
- Produce the **full implementation** needed for the current project (nodes, credentials, tests,
  etc.), not just fragments similar to examples.
- If an example omits parts (e.g. types, operations, properties), **infer and implement the missing
  parts** based on the real requirements / API docs.
- Never output `Wordpress`-specific code unless the project is actually about WordPress.

## Project structure

There are two main folders in this project:

- `nodes` contains all of the nodes in a package (there can be more than 1). The code for each node
  usually lives in its own folder
- `credentials` contains all of the credentials in a package. Usually it's just a single file for
  every credential

So it looks something like this:

```text
.
├── nodes/
│   └── Example/
│       ├── Example.node.ts
│       └── ...
├── credentials/
│   └── Example.credentials.ts
├── package.json
└── ...
```

`package.json` has an `n8n` field that lists the package's nodes and credentials:

```json
{
	"name": "n8n-nodes-example",
	"version": "1.0.0",
	"n8n": {
		"n8nNodesApiVersion": 1,
		"strict": false,
		"credentials": ["dist/credentials/Example.credentials.js"],
		"nodes": ["dist/nodes/Example/Example.node.js"]
	}
}
```

This repository uses `"strict": false` together with its own ESLint config (`eslint.config.mjs`),
because the package has a runtime dependency. Keep it that way. `nodes` and `credentials` keys
contain paths to transpiled JS files in a `dist` folder for the nodes and credentials respectively.
If you add/remove/rename nodes and/or credentials, you need to make sure to update `n8n.nodes` and
`n8n.credentials` keys in `package.json` accordingly. Initial files in the project _may_ contain
example nodes and/or credentials that need to be **removed or renamed** once you start making an
actual node.

## Key guidelines

- Use the `n8n-node` CLI tool **whenever possible** for building, dev mode, linting, etc.
- **Always** address any lint/typecheck errors/warnings, unless there is a **very specific reason**
  to ignore/disable it
- Make sure to use **proper types whenever possible**
- **Don't change the npm package version.** The maintainer decides it, and this repository has no
  `CHANGELOG.md`
- Read `.agents/workflow.md` for more info

## Stellar

- The package has four nodes and two credentials. The README describes each one for users, and
  `ARCHITECTURE.md` says which Stellar API each one uses:
  - Stellar Signer (`n8n-nodes-stellar.stellarSigner`, version 1), with the credential
    `stellarWalletApi` (field `secretKey`), whose help is in `CREDENTIALS.md`;
  - Stellar (`n8n-nodes-stellar.stellar`, version 1), over Horizon, without a credential;
  - Stellar Trigger (`n8n-nodes-stellar.stellarTrigger`, version 1), a polling trigger over Horizon,
    without a credential;
  - Confidential Token (`n8n-nodes-stellar.confidentialToken`, version 1), over Stellar RPC and
    Testnet only, with the credential `confidentialTokenHolderApi`. It is in progress: so far the
    resource `holder` has the operation `register`.
- Don't break the Stellar Signer's contract, which existing workflows depend on:
  - the node type and version above
  - the credential name and its `secretKey` field
  - the credential's optional policy fields, `allowedOperations`, `maxAmounts`, `allowedAssets`,
    `allowedDestinations` and `maxFee`. With all of them empty, and `maxFee` at 0, there is no
    limit, as in a credential saved before they existed. While `maxAmounts`, `allowedAssets` or
    `allowedDestinations` has a line, an empty `allowedOperations` means only the four payment types
    (`payment`, `pathPaymentStrictSend`, `pathPaymentStrictReceive` and `createAccount`). While
    `maxAmounts` has a line, a payment in an asset without a line fails. A `G` destination also
    allows its muxed `M` addresses, and an `M` destination allows only itself. The native asset is
    written `XLM` or `native`
  - the credential's `allowMessageSigning` switch, off by default: Sign Message fails unless it is
    on
  - the `operation` parameter, with `signTransaction` as the default, which n8n does not save in the
    workflow, so a workflow saved without it signs transactions. The other value is `signMessage`,
    with the `message` parameter
  - the output of `signMessage`: the input item's fields plus `message`, `signature` (base64) and
    `publicKey`, without network fields. It doesn't read `networkName` and doesn't call the network
  - the parameters `xdr` and `network`, with `public` as the default, which n8n does not save in the
    workflow, and `mainnet` read as `public`, the value 0.1.1 saved
  - the `networkName` field of each input item (`public` or `testnet`), which must be the same as
    the `network` parameter: the node fails the item without signing it when the field is missing or
    different
  - an XDR that already has a valid signature of the credential's key fails the item before it is
    signed, because the network rejects a repeated signature. A signature of another key is
    co-signing, and the node adds its own
  - the output fields `signedXdr`, `txHash`, `publicKey`, `network` and `networkName` (`public` or
    `testnet`)
  - the optional parameters `submit`, off by default, and `horizonUrl`, which n8n shows only when
    `submit` is on: with `submit` off, the node doesn't call the network and its output is the five
    fields above. n8n shows `xdr`, `network`, `submit` and `horizonUrl` only with `signTransaction`
  - the output fields `submitted` (`true`) and `ledger`, which the node adds when `submit` is on and
    Horizon confirms the transaction
  - the `error` object of an item that fails after it was signed, when the node continues on fail:
    `message`, `description`, `outcome` (`rejected`, `not_submitted` or `uncertain`), `txHash` and
    `signedXdr`. An item that fails before it is signed keeps n8n's usual shape
  - how a submission is judged: submitted for a 200 with the same hash, a ledger above 0 and
    `successful`, or when the look-up below finds the transaction successful; `rejected` for
    Horizon's `transaction_failed` with a failure code, or when the look-up finds it failed;
    `not_submitted` only for the errors Horizon answers before it passes a transaction on, told by
    their `type`; anything else is `uncertain`, and then the node looks the transaction up by its
    hash, at once and every 5 seconds for up to 30 seconds. Not finding it doesn't prove that it
    wasn't applied, because a Horizon server can keep only some transactions: the error sends the
    user to the account's sequence number and gives the transaction's
  - `appliedTransactions` in the data of an error that stops a run after Horizon applied
    transactions of earlier items: `itemIndex`, `txHash` and `ledger` for each one
- The Stellar SDK is `@stellar/stellar-sdk`, pinned to `17.1.0` as a runtime dependency. The
  transaction hash is hex: `Buffer.from(transaction.hash()).toString('hex')`.
- The network names, their passphrases and SDF's Horizon server for each one are in
  `nodes/shared/network.ts`. Use it from any node that needs them.
- The rules for **Horizon URL**, the Horizon client and `nodeForErrors` are in
  `nodes/shared/horizon.ts`. Use them from any node that calls Horizon, with its own text for the
  https error, and name the parameter `horizonUrl`.
- Sign Message signs whatever text reaches it, and a signed text can prove control of the key to
  another service. It stays behind the credential's `allowMessageSigning` switch: don't add a way to
  sign a message without it.
- Each secret key lives only in its credential, and only one node reads each credential:
  `stellarWalletApi` the Stellar Signer, and `confidentialTokenHolderApi` the Confidential Token
  node. A key never appears in the output, in error messages or in logs. The Stellar node and the
  Stellar Trigger have no key and sign nothing: keep it that way, and build unsigned transactions
  there for the Stellar Signer.
- The Stellar node keeps one file per operation in `nodes/Stellar/actions/<resource>/`, a router,
  and its Horizon reads in `nodes/Stellar/transport/horizon.ts`. A new operation goes there in the
  same shape. Every output item carries `networkName`, which the Stellar Signer checks, and the
  default network is `public`.
- The Stellar Trigger keeps its memory between polls in the node's static data
  (`nodes/StellarTrigger/memory.ts`). Each event owns that memory, and changing the event clears it.
- The Confidential Token node's errors and logs carry no amount, balance or key. Its policy checks
  are in `nodes/shared/policy.ts` (`checkConfidentialAmount` before the proof,
  `checkConfidentialFee` after the simulation), its encrypted state and its account lock in
  `nodes/ConfidentialToken/state/`, and the derivation of its keys, which recalculates the SEP-53
  signature on every run and never stores it, in `nodes/ConfidentialToken/keys.ts`.
- `vendor/stellar-confidential-token-sdk/` is a copy of a third-party SDK, compiled with the
  package. ESLint and Prettier skip its `src/`. Change it only when you must, mark every changed
  line with a comment that starts with `n8n-nodes-stellar:` (or a `begin`/`end` pair of them around
  a block), and list the change in its `VENDORED.md`.
- The value of **Horizon URL** can carry a provider's key. The node keeps it out of the errors that
  n8n stores and sends to an error workflow. Every error that the node creates, or that passes
  through its `catch` blocks, gets a copy of the node with that parameter hidden (`nodeForErrors`),
  and no error text names more of the address than the server. Pass that copy, `node`, to every new
  error, never `this.getNode()`. Two things stay outside the node: n8n keeps the address in the
  workflow and in the saved execution, and with **On Error** on **Stop Workflow** the error that n8n
  throws for a missing credential goes out as it came.
- The signing policy is in `nodes/shared/policy.ts`, which doesn't import n8n. It reads the
  credential's policy fields and checks the decoded transaction before the node signs it. A new
  control goes there. A credential that the node can't use signs nothing: n8n can't hand it over,
  the secret key is empty, or a policy field can't be read. The node then throws before the items.
  With **On Error** on a **Continue** option it returns every item as failed with that error
  instead, in the shape of an item that fails before signing, because n8n would pass the input items
  on unsigned if the node threw. Policy errors give the line number, never the text that was
  entered.
- The package is not eligible for n8n Cloud: it has a runtime dependency and its own ESLint config.
- Format with `npm run format` and check with `npx prettier --check .`.

## Context-specific docs

Load these before working on the relevant area:

| Working on...                   | Read first                                     |
| ------------------------------- | ---------------------------------------------- |
| Any node file in `nodes/`       | `.agents/nodes.md` and `.agents/properties.md` |
| A declarative-style node        | above + `.agents/nodes-declarative.md`         |
| A programmatic-style node       | above + `.agents/nodes-programmatic.md`        |
| Files in `credentials/`         | `.agents/credentials.md`                       |
| Adding a new version to a node  | `.agents/versioning.md`                        |
| Starting a new task or planning | `.agents/workflow.md`                          |

## Additional resources

If you need any extra information, here are links to n8n's official docs regarding building
community nodes:

- https://docs.n8n.io/integrations/community-nodes/build-community-nodes/
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/
