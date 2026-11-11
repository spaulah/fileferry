# @fileferry/fake-graph

An in-memory fake of the Microsoft Graph and SharePoint endpoints that the sharing engine uses: sites, drives, folders, file content, resumable upload sessions and invitations. It is a plain `fetch` handler, so it runs in Node tests and in the browser.

```ts
import { createFakeGraph } from '@fileferry/fake-graph';
import { ShareClient } from '@fileferry/core';

const graph = createFakeGraph({ siteUrl: 'https://contoso.sharepoint.com/sites/legal', libraries: ['Shared Documents'] });

// Make the second upload reply get lost after the server applied it.
graph.addFault({ method: 'PUT', path: /\/content$/, phase: 'after', effect: 'network', skip: 1 });

const client = new ShareClient({
  siteUrl: 'https://contoso.sharepoint.com/sites/legal',
  libraryName: 'Shared Documents',
  graph: { baseUrl: graph.baseUrl, getAccessToken: async () => 'test', fetch: graph.fetch },
});
```

## Faults

A `FaultRule` can match by method, path, or a predicate, and can apply in one of two phases:

- `phase: 'before'` (default): the request has no effect and fails.
- `phase: 'after'`: the request is applied, then the reply is replaced. With `effect: 'network'`, the reply is lost on the way back. This is the case that exposes non-idempotent retry logic.

Effects are an HTTP status, optionally with a `Retry-After`, or `'network'`. `times` limits how many matching requests fail, and `skip` lets some through first.

## Inspecting the result

- `graph.items(library?)` lists folders and files.
- `graph.readFile(path, library?)` returns the stored bytes.
- `graph.invitations` lists every invitation sent, including `requireSignIn` and `roles`.
- `graph.stats` counts folder creates, replacements (which should stay 0), completed uploads and peak concurrent uploads.
- `graph.log` records each request and its status.

## Limits

The fake implements only what the sharing engine calls. It accepts any bearer token, and it does not enforce permissions or quotas. Use it to test sharing logic, not to test SharePoint behavior.
