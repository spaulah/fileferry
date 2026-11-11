# @fileferry/core

The sharing engine for external sharing of folders and files. It is framework-free TypeScript with no runtime dependencies, and it works in browsers and Node.

Status: the SharePoint and OneDrive logic has been in production for months, in the SPFx web part this engine was extracted from. The Dropbox provider has been tested against a real account. The standalone engine has not yet been tested against a SharePoint tenant.

It shares through a `StorageProvider`. Two providers are included:

- `GraphStorageProvider`: SharePoint and OneDrive document libraries, through Microsoft Graph.
- `DropboxStorageProvider`: Dropbox, through the HTTP API v2.

```ts
import { DropboxStorageProvider, ShareClient } from '@fileferry/core';

const client = new ShareClient({
  provider: new DropboxStorageProvider({ accessToken: () => acquireToken(), rootPath: 'Shared' }),
});

const result = await client.share({
  caseTitle: 'Smith v. Jones',
  audiences: [{ name: 'Client', folderName: 'Client', recipients: 'alice@example.com', access: 'write' }],
});
```

The engine validates the request before anything is created, creates folders parents first, bounds upload concurrency, and reports each invitation's outcome. Each provider retries transient failures and resumes large uploads.

Full documentation, including the guarantees, the verification status and the design decisions, is in the repository README and docs/DESIGN.md.
