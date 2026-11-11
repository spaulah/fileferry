# External Share

Share folders and files with people outside your organization, without the usual failure modes: duplicated folders after a lost reply, half-finished uploads, unexplained "Failed to fetch" errors, and invitations that silently don't go out.

The SharePoint and OneDrive logic, through Microsoft Graph, has been in production for months, in the SPFx web part this engine was extracted from. The standalone engine is not yet tested against a tenant. The Dropbox provider has been tested against a real Dropbox account: folders, uploads, sharing and invitations all worked. Box and Google Drive are planned (see [Roadmap](#roadmap)).

The core is a framework-free TypeScript library. A browser demo shows the hard cases against in-memory fakes of SharePoint and Dropbox, so you can try them without an account.

## Why this exists

Sharing a package of files with different people, with different rights, is harder than it looks. Legal, accounting and tax teams do this routinely, and the business logic ends up scattered across customizations that are hard to maintain. This project puts that logic in one tested library, with thin interfaces on top. [The full story](docs/STORY.md) explains where it came from.

> **Status: 0.x, pre-release.** The API may change. The Graph logic has run in production for months in the SPFx web part this engine was extracted from. The standalone engine has not yet been run against a tenant. The Dropbox provider has been run against a real account. See [Verifying against a real tenant](#verifying-against-a-real-tenant).

## Packages

| Path                                             | Package                        | What it is                                                                                                                             |
| ------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core)                 | `@fileferry/core`         | The sharing engine: planning, validation, retries, resumable uploads, invitations, progress. No SharePoint or React dependency.        |
| [`packages/fake-graph`](packages/fake-graph)     | `@fileferry/fake-graph`   | An in-memory fetch handler that imitates the Graph endpoints used for sharing, with fault injection. Works in Node and in the browser. |
| [`packages/fake-dropbox`](packages/fake-dropbox) | `@fileferry/fake-dropbox` | The same idea for the Dropbox HTTP API v2, including the offset error that upload sessions use.                                        |
| [`apps/demo`](apps/demo)                         | `@fileferry/demo`         | A React app. Pick files or folders, choose recipients, and watch each step. Presets reproduce real failures.                           |
| [`docs/DESIGN.md`](docs/DESIGN.md)               |                                | Why the engine behaves the way it does, and what changed from the original SharePoint-only implementation.                             |
| [`docs/STORY.md`](docs/STORY.md)                 |                                | Why this project exists, in the author's words.                                                                                        |

## Quick start

```bash
npm install
npm run build        # builds the packages, then the demo
npm test             # 86 tests, including end-to-end runs against both fakes
npm run dev -w @fileferry/demo
```

Open the printed URL. In step 3, choose a platform and **Simulated service**, pick a failure to rehearse, add sample files in step 4, and press **Share**.

## Using the engine

The engine shares through a _storage provider_. The sharing rules are the same for every provider. Only the calls to the platform change.

```ts
import {
  DropboxStorageProvider,
  GraphStorageProvider,
  ShareClient,
  collectFromFileList,
} from "@fileferry/core";

// SharePoint and OneDrive, through Microsoft Graph
const provider = new GraphStorageProvider({
  siteUrl: "https://contoso.sharepoint.com/sites/legal",
  libraryName: "Shared Documents",
  graph: { getAccessToken: () => acquireGraphToken() }, // your auth; MSAL is typical
});

// or Dropbox, through its HTTP API v2
// const provider = new DropboxStorageProvider({ accessToken: () => acquireDropboxToken(), rootPath: 'Shared' });

const client = new ShareClient({
  provider,
  onProgress: (event) => console.log(event.phase, event.status, event.message),
});

const result = await client.share({
  caseNumber: "2024-001",
  caseTitle: "Smith v. Jones",
  audiences: [
    {
      name: "Client",
      folderName: "Client",
      files: collectFromFileList(Array.from(input.files)).files,
      recipients: "alice@example.com, bob@example.com",
      access: "write",
    },
    {
      name: "Opposing Counsel",
      folderName: "Opposing Counsel",
      recipients: "carol@example.org",
      access: "read",
    },
  ],
});

for (const audience of result.audiences) {
  for (const invitation of audience.invitations) {
    if (invitation.status === "failed")
      console.warn(invitation.recipient, invitation.error);
  }
}
```

To add a platform, implement the `StorageProvider` interface in `packages/core/src/provider.ts`. It has five operations: connect, ensure a folder, upload a file, return a folder link, and invite a recipient. The engine does not change.

`share()` throws only when the whole operation cannot proceed, for example a validation error or a folder that cannot be created. Individual recipients that fail are reported in `result.audiences[].invitations` and do not stop the others.

## What the engine guarantees

These hold against the in-memory fakes. The SharePoint logic they describe has run in production for months, in the SPFx web part this engine was extracted from.

- **Nothing is created until the request is valid.** Emails, names, path lengths and readable files are all checked first. An unreadable file (a locked file, an un-downloaded cloud file, or a folder dropped by mistake) is reported before any remote call.
- **Re-running a share is safe.** Folders are looked up before they are created, so a create whose reply was lost is not sent again. Files are overwritten.
- **Only transient failures are retried.** Throttling (429), server errors (5xx) and dropped connections are retried with backoff. A `Retry-After` header is honored. Permission errors and bad requests are not retried. For invitations, they move on to the fallback chain instead.
- **Large uploads resume.** Files above a per-provider size (4 MiB for SharePoint, 8 MiB for Dropbox) upload in chunks. After a lost reply, the engine asks the upload session where to resume, so no byte is sent twice and none is skipped.
- **Concurrency is bounded.** Uploads run three at a time by default. Folders are created parents first, so uploads never race to create them.
- **SharePoint invitations have a fallback chain.** Graph with sign-in required, then Graph without it (some tenants accept external users only in that mode), then an optional fallback you provide, for example SharePoint REST `ShareObject`. Dropbox sends its own invitation email when a member is added.
- **Follow-up work never fails a share.** A notification or queue write that fails becomes a warning in the result.

## What it does not do

- It does not authenticate. You supply a token provider. MSAL is the usual choice in a browser.
- It does not manage recipients, notification queues or team lists. Those belong to your application; use `onFoldersShared` to hook them in.
- It does not yet support sharing links. It sends invitations only.

## Status and evidence

What is verified:

- 86 automated tests: unit tests for planning, validation, retries and uploads, plus engine integration tests against both fakes. They cover lost replies, throttling, chunked-upload resume, invitation fallback, partial failure, and Dropbox's shared-folder reuse and access mapping.
- A mutation check: removing the folder existence check makes the idempotency tests fail.
- The demo's production build, run in headless Chrome with no console errors. For SharePoint: the clean, throttled, lost-reply, refused-sign-in and locked-file presets, and the legal, manufacturing and accounting scenarios. For Dropbox: the clean, lost-reply and refused-invitation presets. Not run in the browser: the SharePoint flaky-network preset, the blank scenario, and the Dropbox throttled, flaky-network and locked-file presets.
- Strict TypeScript and type-aware lint, run locally with `npm run check`. A GitHub Actions workflow runs the same steps, but its results are not confirmed here.

What is not verified yet:

- The standalone engine against a live SharePoint or OneDrive tenant. The Graph logic has been in production for months in the SPFx web part, which is the strongest evidence so far, but the extracted engine itself has not yet been run against a tenant.
- Authentication. The demo takes a pasted token; no MSAL flow exists yet.
- Dropbox at scale. One live run covered connecting, folder creation, a small upload, sharing, invitations to two recipients and follow-up notifications. Not yet tested live: large upload sessions, rate-limited invitations, repeat runs, and recipients' access to the folder link. The steps are in [docs/TESTING-DROPBOX.md](docs/TESTING-DROPBOX.md).
- The Box and Google Drive providers, and the SharePoint Framework client.
- Performance with large libraries, and a security review.

## Roadmap

Storage providers. The engine shares through a `StorageProvider` interface, so each platform plugs in without touching the sharing rules.

| Provider                                  | Status                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| SharePoint and OneDrive (Microsoft Graph) | In production for months in the SPFx web part. Standalone engine not yet tested against a tenant. |
| Dropbox                                   | Working. Tested against a real Dropbox account ([how to test](docs/TESTING-DROPBOX.md)). |
| Box                                       | Planned                                                                        |
| Google Drive                              | Planned                                                                        |

Clients. The React demo is the reference client. A SharePoint Framework web part is planned as the first production adapter, using the same engine.

## Verifying against a real tenant

The fakes encode the Graph and Dropbox endpoints and responses this engine relies on. The Graph logic has been in production for months, in the SPFx web part, so the SharePoint behavior is the best-tested part. For the standalone engine and the Dropbox provider, run the demo's **Live** mode against a SharePoint test site and against a Dropbox test account. For Dropbox, follow [docs/TESTING-DROPBOX.md](docs/TESTING-DROPBOX.md) to get a token. Check invitation emails, folder links and resumable uploads. Any difference between a fake and the real service should be fixed in the fake and covered by a test.

## Development

- `npm run check` runs everything CI runs: build, typecheck, lint and tests, in that order.
- `npm run build` must run before `npm run typecheck`. The demo imports the built packages from their `dist` output.
- `npm run typecheck` checks every package, including the tests.
- `npm run lint` runs ESLint with type-aware `typescript-eslint` rules (strict and stylistic).
- `npm test` runs the unit tests and the engine integration tests (`packages/core/test`).
- Releases are described in [docs/RELEASING.md](docs/RELEASING.md).
- The integration tests use `packages/fake-graph/src` directly through a Vitest alias, so they need no build step.

## License

MIT. See [LICENSE](LICENSE).
