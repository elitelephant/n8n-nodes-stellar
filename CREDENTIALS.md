# Stellar Wallet API credential

The Stellar Signer node signs transactions with the secret key stored in this credential.

## The secret key

- A Stellar account has two keys. The public key starts with `G` and identifies the account, so it's
  safe to share. The secret key starts with `S` and gives full control over the account and all its
  funds. Each key is 56 characters long.
- The credential doesn't store a network. The node signs with this secret key for the network chosen
  in its **Network** parameter.
- The same secret key works on Mainnet and on Testnet, but each network has its own accounts: an
  account created on Testnet doesn't exist on Mainnet.
- The node returns the public key that matches the secret key in its `publicKey` output field. It
  never returns the secret key.

## Get a secret key on Testnet

Testnet works like Mainnet but doesn't connect to real money. To create a Testnet account:

1. Open the [Create Account Keypair](https://lab.stellar.org/account/create) page of Stellar Lab.
   Check that the network in the upper right corner of the page is Testnet.
2. Click **Generate keypair**.
3. Click **Fund account with Friendbot** to add 10,000 test XLM to the account.
4. Paste the secret key into the **Secret Key** field of this credential and save it. When you save
   it, n8n checks the secret key. If it is valid, n8n only shows _Connection tested successfully_.
   To see which account the key belongs to, look at the `publicKey` field in the Stellar Signer's
   output after it signs a transaction.

Testnet is usually reset 2 to 4 times a year, and a reset deletes every account. After a reset, fund
the account again or create a new one.

## Keep it safe

- Never share the secret key. Keep it only in this credential: don't paste it into node parameters
  or workflow notes, which are saved as part of the workflow.
- Use a separate account for each workflow or purpose, with only the funds it needs.
- Try your workflow on Testnet first. On Mainnet, a signed transaction moves real funds once it is
  submitted to the network.
- Mainnet is the node's default network. Check the **Network** parameter before you run a workflow.

More about accounts and keys:
[Create an account](https://developers.stellar.org/docs/build/guides/transactions/create-account) in
the Stellar docs.
