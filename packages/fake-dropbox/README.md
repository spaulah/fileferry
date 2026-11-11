# @fileferry/fake-dropbox

An in-memory fake of the Dropbox HTTP API v2 endpoints that the sharing engine uses: folders, uploads (single request and upload sessions), sharing and membership. It is a fetch handler, so it runs in Node tests and in the browser.

```ts
import { createFakeDropbox } from '@fileferry/fake-dropbox';
import { DropboxStorageProvider } from '@fileferry/core';

const dropbox = createFakeDropbox();
dropbox.addFault({ route: 'files/upload', effect: { status: 429, retryAfterSeconds: 1 }, times: 1 });

const provider = new DropboxStorageProvider({
  accessToken: async () => 'test',
  apiBaseUrl: dropbox.apiBaseUrl,
  contentBaseUrl: dropbox.contentBaseUrl,
  fetch: dropbox.fetch,
});
```

Faults can apply before a request has any effect, or after it has been applied with the reply lost. The error bodies follow the shapes in Dropbox's public API specification, including the offset error that tells an upload session where it really is.

The fake is tested against the specification, not against a live Dropbox account. Its limits are described in the repository's docs/DESIGN.md.
