# Design notes

This document explains why the engine behaves as it does. It is aimed at maintainers and at anyone deciding whether to rely on it. It also records what changed from the SharePoint-only service it was extracted from.

## Goals

1. Run in a browser, in Node, and in tests, with no SPFx or React dependency.
2. Make failure modes testable. Behaviors that matter are covered by tests. For the folder-idempotency logic, the tests were also checked to fail when the logic is removed.
3. Keep the public surface small: one client, one request shape, one result shape.

## Decisions

### Validate and check before the first remote call

`planShare()` is pure. It validates emails, names, duplicate groups and case names, and builds the full list of folders and uploads. `assertReadable()` then reads one byte from each file. `share()` checks path lengths against the library path before creating anything.

**Why:** a failure partway through a share leaves partial folders and files in a client's library, which is worse than refusing up front. The original service already did this for path lengths and readability. The engine now does it for everything.

### Create folders with an existence check on every attempt

`getOrCreateFolder()` looks the folder up on every attempt. Only then does it POST with `conflictBehavior: replace`. The lookup repeats inside the retry loop.

**Why:** if the create succeeds but its reply is lost, a retry that POSTs again would *replace* the folder. The fake's `replacedFolders` counter and the test "does not duplicate folders when the create reply is lost" guard this. Disabling the existence check fails both idempotency tests.

### Retry only what can succeed on retry

Transient means a network failure, a 429, or a 500/502/503/504. `Retry-After` is honored when present, and otherwise backoff is exponential and capped. The default is 4 attempts.

**Why:** retrying a 403 or a 400 wastes time and can trigger more throttling. The original service had the same rule; the engine keeps it and tests it.

### Resume uploads from the server's byte count

For resumable uploads, a retried chunk first asks the upload session for `nextExpectedRanges`, then continues from there.

**Why:** a chunk can be received even when its reply is lost. Resending it from the old offset would corrupt the file or fail. The integration test loses one chunk reply and checks that the final bytes match the source.

### Limit upload concurrency, and create folders sequentially

Uploads run three at a time by default. Folders are created one at a time, parents first.

**Why:** the original code notes that too many simultaneous requests cause throttling, and throttled replies often lack CORS headers, so the browser reports them as "Failed to fetch". Creating folders in parallel lets two uploads race to create the same parent.

### Invitations: fallback chain, and per-recipient results

Each recipient gets: Graph with sign-in required, then Graph without it, then the optional `inviteFallback`. Every attempt's error is reported together. Recipients run in parallel, and one failure does not stop the others.

**Why:** the original service's fallback chain existed because some tenants reject new external users in one mode and accept them in another. Reporting per recipient means a user can see who did not receive the invitation, instead of getting an all-or-nothing error.

**Tradeoff:** a Graph invitation is retried on throttling or 5xx responses. If the first request was processed but its reply was lost, a retry sends a second invitation email. Throttled and failed requests were not processed, so the retry is the better choice in those cases. The tradeoff is documented here rather than hidden.

### Follow-up work is never fatal

`onFoldersShared` runs after invitations, once per audience that gained an invitation. Its errors and any returned strings become `result.warnings`.

**Why:** the files are already shared when this runs. A notification failure should not make the user think the share failed.

## Changes from the original SharePoint service

| Area | Original | Engine |
| --- | --- | --- |
| Audiences | Two fixed: Client and Opposing Counsel | Any number, each with a name, folder, recipients, access and subject |
| Empty audiences | Both folders always created | Only audiences with files, folders or recipients are created |
| Invitation failure | `Promise.all` rejects on the first failure, so the caller gets one error and no per-recipient result | Each recipient's outcome is returned; the caller decides what to do |
| Invitation retries | None; the fallback chain acted as the retry | Transient errors retried, then the fallback chain |
| Notifications | Built into the service, using SharePoint lists | `onFoldersShared` hook; the list logic stays in the SPFx adapter |
| Fallback | `SP.Web.ShareObject` built in | `inviteFallback` option; the SPFx adapter supplies it |
| Dependencies | `@microsoft/sp-http`, SharePoint REST | `fetch` only |

## Not included

- **Authentication.** The caller supplies a token function.
- **SharePoint REST lists** (notification queue, Legal Team list) and the people picker. These are specific to one application.
- **Sharing links.** The engine sends invitations only.
- **Live-tenant test coverage.** The Graph logic has been in production for months in the SPFx web part this engine was extracted from. The standalone engine and the Dropbox provider are tested against fakes, and not yet against a live tenant or account. See the README section on verifying against a real tenant.

## Open questions

- Whether `access: 'read'` needs its own tests against the real Graph, since the fake accepts any role.
- Whether invitation retries should be disabled by default, to avoid duplicate emails. Currently they are enabled.

## Storage providers

The engine shares through a `StorageProvider`, defined in `packages/core/src/provider.ts`. It has five operations: `connect`, `ensureFolder`, `uploadFile`, `folderLink` and `invite`. The engine owns everything else: validation, planning, folder order, concurrency, progress, and the per-recipient results.

**Why an interface instead of a platform switch.** Each platform needs different calls for the same steps. Dropbox shares a folder first and then adds members, while Graph looks up an item and invites on it. Keeping the platform-specific parts behind five operations means a new platform changes one class. The sharing rules stay in one place and are tested once.

**Where retries live.** Each provider owns its retry policy and upload settings, because the transient errors and resume rules differ. Both providers use the same definition of transient failure: a network failure, 429, or 5xx.

**Idempotency differs by platform.** Graph folders are checked before they are created, because a second create would replace the folder. Dropbox's create returns a conflict when the folder exists, and the provider treats that as success. Either way, a lost reply does not create a duplicate.

## Dropbox: what is verified and what is not

The Dropbox provider was written from Dropbox's public API specification, in the Stone files at `github.com/dropbox/dropbox-api-spec`. The developer documentation pages are rendered in JavaScript, and the error-handling guide returned 404 when fetched, so the Stone files were the primary source.

It has since been run against a real Dropbox account. One run covered connecting, folder creation, a small file upload, sharing with editor access, invitations to two recipients, and follow-up notifications, with no errors. That run confirmed the endpoints and request shapes the basic path uses. The items below that the run exercised are marked confirmed; the rest remain open.

Verified against the fetched Stone text:

- Upload sessions use a cursor of `session_id` and `offset`. A finish call takes `cursor`, `commit` and `content_hash`.
- The offset error is `lookup_failed` with the tag `incorrect_offset`, which carries `correct_offset`. The provider resumes from that offset.
- Folder creation returns `path` with a `conflict` tag whose payload is `folder` when a folder is already there.
- `get_metadata` reports `path/not_found` through a `LookupError`.
- Access levels are `owner`, `editor`, `viewer`, `viewer_no_comment`, `traverse` and `no_access`. The provider uses `editor` for write and `viewer` for read.
- A single-request upload is limited to 150 MiB. The provider uses sessions above 8 MiB.

From the Stone summary of the parts that were not fetched verbatim. Check these first against a live account:

- `sharing/share_folder`: the request fields, and that an already-shared folder is reported as `bad_path` with an `already_shared` payload holding `shared_folder_id`. The provider searches the error body for `shared_folder_id`, so it works if the nesting differs.
- `sharing/add_folder_member`: the request fields `shared_folder_id`, `members`, `custom_message` and `quiet`, and the member selector `email`. The error tag `rate_limit` appears only in this endpoint's error union.
- Route names. The Stone name `create_folder:2` is assumed to map to the HTTP route `files/create_folder_v2`. The session routes map the same way: `upload_session/append_v2`.
- `upload_session/start` and `append_v2` take `close`. The provider sends `close: false` and sends `finish` for the last bytes.

Not verified:

- The commit mode `overwrite` for uploads. This is the standard Dropbox mode, but the fetched text did not include the `WriteMode` definition.
- That a no-argument call should send the JSON body `null`.
- Whether the Dropbox-API-Arg header encoding, with non-ASCII escaping, matches what the service expects. The provider escapes non-ASCII characters as `\uXXXX`.
- The folder link. The provider returns `https://www.dropbox.com/home/...`, which works for the owner. Whether a recipient can open that URL depends on how the folder was shared, so the recipient mainly relies on Dropbox's own email.
- Async sharing. `force_async` is set to false, so the provider never waits on a job. A folder large enough to need an async job would fail rather than wait.
- Error envelope. The provider assumes `error_summary` and `error` in every 409 reply, as the Stone error unions suggest. The error-handling guide that would confirm this could not be fetched.

Still open, because the live run did not exercise them: upload sessions for large files (including offset recovery after a lost reply), rate-limited invitations, repeat runs against existing folders, and whether recipients can open the folder link directly. The fake covers these shapes in tests, but passing those tests does not show the service behaves the same way.
