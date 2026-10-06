# Workflow

## How to work on this project

When asked to build or update a node in this project, follow these steps:

1. Clarify the requirements. Ask for (if not already provided):
   - Which resources and operations the node needs to have
   - The authentication method (API key, OAuth2, etc)
   - Example use case or sample payloads, if available

   Do this **only** if there are multiple options **after** gathering information and you are not
   sure which to pick

2. Decide on the node style (declarative vs programmatic):
   - The nodes in this package use the Stellar SDK to build, sign and read transactions, which a
     declarative node can't do. They are programmatic-style (see `.agents/nodes-programmatic.md`)
3. Plan before coding:
   - Outline what description the node will have, its resources and operations
   - Which credentials the node will use and their properties
   - Confirm the plan, if you are not given one and are generating it
   - **Never start coding without a plan**
4. Implement. Create or update:
   - The node files (`nodes/<n>/<n>.node.ts`)
   - The credentials files (`credentials/<n>.credentials.ts`)
   - Other files with helpers and extracted functions/classes
   - `package.json` (`n8n.nodes` and `n8n.credentials` entries)
5. Quality checks:
   - Build the project to ensure it actually builds
   - Run the linter to make sure that there aren't any warnings or errors
   - Ensure UX follows the
     [n8n UX guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/)
   - Ensure the credentials are secure (sensitive values **are marked as `password`**, **no secrets
     logged** and **there aren't any hardcoded secrets**)
   - Run the project, so that the user can manually verify that it works. Ask the user on how to run
     it, and if something goes wrong tell them to run it themselves
6. Iterate on the code, if needed, going through the process again:
   - Plan
   - Implement
   - Verify

## Development guidelines

- Use the `n8n-node` CLI tool **whenever possible**, so for stuff like building a node, using dev
  mode with hot-reload linting, etc. Using this tool is the best way to make sure the code is of
  high quality and complies with n8n's standards
- **Always** make sure to address any lint/typecheck errors/warnings, unless there is a **very
  specific reason** to ignore/disable it. Linter is your best friend to make sure the code is of
  high quality and complies with n8n's standards
- Before making any changes to the code, make sure you've gathered all required context and
  **planned out** what you're going to do. If the plan looks good, make sure to stick to it to
  ensure the code you produce is doing what the user expects
- After making changes verify that there are no lint/typecheck issues. Also allow the user to
  manually test the node in n8n to verify that it does what is expected
- Make sure to use **proper types whenever possible**
- **Don't change the npm package version.** The maintainer decides it, and this repository has no
  `CHANGELOG.md`

## CLI

This project uses n8n's CLI tool for developing community nodes: `n8n-node`. It is available as a
dev dependency and `package.json` has some aliases for common commands. Short overview of the
commands:

- `n8n-node dev` - run n8n with your node in development mode with hot reload. This command starts
  up n8n on `http://localhost:5678` so that the user can manually test the node. It also links it to
  n8n's custom nodes directory (`~/.n8n-node-cli/.n8n/custom` by default), so it's available within
  n8n. `--external-n8n` makes it not launch n8n and `--custom-user-folder <path>` can be used to
  specify the folder where user-specific data is stored (`~/.n8n-node-cli` is the default)
- `n8n-node build` - compile your node and prepare it for distribution.
- `n8n-node lint` - lint the node in the current directory. Use `--fix` flag to automatically fix
  fixable issues.
- `n8n-node cloud-support` - manage n8n Cloud eligibility. If invoked without arguments, show
  current cloud support status. Invoke `n8n-node cloud-support enable` to enable strict mode +
  default ESLint config or `n8n-node cloud-support disable` to allow custom ESLint config (disables
  cloud eligibility). **Don't run `n8n-node cloud-support enable` in this repository**: the package
  has a runtime dependency (`@stellar/stellar-sdk`) and its own ESLint config, so it is not eligible
  for n8n Cloud
- `n8n-node release` - the release process using `release-it`. In this repository it doesn't publish
  from your machine: `npm run release` requires a `main` branch (this repository uses `master`),
  publishing to npm goes through a GitHub Actions `publish.yml` workflow that the repository doesn't
  have yet, and a direct `npm publish` is stopped by `prepublishOnly`. Leave releases to the
  maintainer
