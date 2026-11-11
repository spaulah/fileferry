# Releasing

Packages are published to npm under the `@fileferry` scope. Versions are managed with [Changesets](https://github.com/changesets/changesets), and the release workflow publishes from `main` with npm provenance.

## Versioning policy

- **Semver, with 0.x rules.** While the major version is 0, a breaking change bumps the minor version (0.1.0 → 0.2.0). A new feature or a fix bumps the patch version (0.1.0 → 0.1.1).
- **Versions track the package API, not the repository.** Moving the project to a new repository does not change any version. The first public release is `0.1.0`.
- **Packages version independently.** `@fileferry/core`, `@fileferry/fake-graph` and `@fileferry/fake-dropbox` each have their own version and changelog.
- **Never republish a version.** npm does not allow a version number to be reused, so a bad release is fixed with a new patch version.
- **Pre-releases** (for example `0.2.0-beta.0`) use Changesets pre mode: `npx changeset pre enter beta`.

## Everyday release

1. Make a change on a branch and add a changeset describing it:
   ```bash
   npx changeset
   ```
   Choose the packages affected and the bump type, then write a short summary. The summary becomes the changelog entry.
2. Merge the pull request into `main`.
3. The **Release** workflow updates or opens a pull request titled "chore: version packages". It bumps the versions and writes the changelogs.
4. Review and merge that pull request. The workflow then publishes the new versions to npm and creates a GitHub release for each one.

A change that needs no release, such as documentation or CI, does not need a changeset.

## First release

npm trusted publishing can only be configured for a package that already exists, so the first release of each package is published by hand. Do this once, from the `main` branch of `github.com/spaulah/fileferry`.

1. Check everything passes:
   ```bash
   npm ci && npm run check
   ```
2. Log in to npm with two-factor authentication enabled:
   ```bash
   npm login
   npm whoami
   ```
3. Publish each package. Provenance can only be generated in GitHub Actions, so turn it off for this one manual publish:
   ```bash
   npm publish --workspace packages/core --access public --provenance=false
   npm publish --workspace packages/fake-graph --access public --provenance=false
   npm publish --workspace packages/fake-dropbox --access public --provenance=false
   ```
4. On npmjs.com, open each package's **Settings**, find **Trusted publisher**, and add a GitHub Actions publisher with:
   - organization or user: `spaulah` (the GitHub owner, not the npm organization)
   - repository: `fileferry`
   - workflow filename: `release.yml`
   - environment: leave empty

From then on, releases go through the Release workflow with provenance, and no npm token is stored in the repository.

## Checks

- `npm run check` builds, typechecks, lints, tests and validates every package with `publint`. It runs in CI and before every release.
- `publint` checks the package exports and metadata. It does not check what the engine does, which the tests cover.
