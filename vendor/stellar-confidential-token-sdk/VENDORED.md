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

`src/`, `circuits/`, `LICENSE` and `README.md`, from that commit, as upstream wrote them. The tests,
scripts, `package.json` and lock file stay upstream. The SDK was tested with these runtime
dependencies:

| Dependency              | Version       |
| ----------------------- | ------------- |
| `@aztec/bb.js`          | 0.87.0        |
| `@noir-lang/noir_js`    | 1.0.0-beta.11 |
| `@noble/curves`         | 1.9.7         |
| `@noble/hashes`         | 1.8.0         |
| `@zkpassport/poseidon2` | 0.6.2         |
| `@stellar/stellar-sdk`  | 14.6.1        |

The folder is left out of ESLint and Prettier, so the copy stays as upstream wrote it.
