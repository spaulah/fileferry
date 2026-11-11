# Testing the Dropbox provider with a real account

This guide gets a short-lived access token from the Dropbox App Console, so you can run the demo's live mode against your own Dropbox account.

**Status:** these steps were followed in a live run against a real Dropbox account. Folder creation, upload, sharing and invitations all worked with no errors. The section 5 items are still to be tested.

Dropbox changes its developer pages from time to time. Button and menu labels below may differ slightly, but the steps and the scopes are what matter.

## 1. Create an app

1. Sign in at <https://www.dropbox.com/developers/apps> with the Dropbox account you want to test with.
2. Click **Create app**.
3. Choose **Scoped access**.
4. Choose **Full Dropbox**. This gives the app access to your whole Dropbox, which the sharing calls need for folders outside any app folder. An app folder may restrict sharing; this has not been tested.
5. Give the app a unique name, for example `external-share-test`. Dropbox app names must be unique across all apps.
6. Click **Create app**.

## 2. Enable the scopes the provider needs

Open the **Permissions** tab and tick these scopes:

| Scope | Why the provider needs it |
| --- | --- |
| `account_info.read` | The connect step calls `users/get_current_account` to confirm the token works. |
| `files.metadata.read` | Reads folder and file metadata. |
| `files.content.write` | Creates folders and uploads files, including upload sessions for large files. |
| `files.content.read` | Reads file content back. |
| `sharing.write` | Shares folders and adds members with editor or viewer access. |

Click **Submit** at the bottom of the page. Dropbox saves the scopes to the app.

If you change scopes later, you must generate a new token. A token only carries the scopes that were enabled when it was generated.

## 3. Generate the access token

1. Open the **Settings** tab.
2. Find **OAuth 2**, then the **Generated access token** section.
3. Click **Generate**.
4. Copy the token that appears.

Generated tokens are short-lived, so expect them to expire after a few hours. Generate a new one when a test starts failing with an authentication error.

## 4. Run the demo against your account

From the repository root:

```bash
npm install
npm run build
npm run dev -w @fileferry/demo
```

Open the printed address and follow these steps:

1. In **Platform**, choose **Dropbox**.
2. In **How to run it**, choose **My real account**.
3. In **Connect to Dropbox**, paste the token into **Access token**. The status line should change to "Ready to share with Dropbox."
4. In step 2, enter a test case number and title, for example `TEST-001` and `Dropbox smoke test`.
5. In step 4, add a recipient you control, for example a second email address. Leave the other group empty, or delete it.
6. Add a small file with **Add sample files** or **Pick files**.
7. Press **Share**.

The progress list should show these steps, in order: connecting, creating each folder, uploading, preparing the folder, and inviting. The result panel shows whether each invitation was sent.

Then check Dropbox itself. The folders appear under `/Shared` in your Dropbox, with the file in the right folder. Dropbox sends the invitation email to the recipient, and the folder shows as shared in your account.

## 5. Things to watch for

- **Network errors on the first call.** The demo calls the Dropbox API from the browser. If the connect step fails with a network or CORS-style error, note the exact message and the browser console output. This has not yet been tested, and it would be a real finding.
- **Authentication failures.** A 401 means the token has expired or lacks a scope. Check step 2 and generate a new token.
- **Invitation outcomes.** A rate limit on membership changes appears as a failed invitation in the result panel. Other recipients should still succeed.
- **Repeat runs.** Run the same case twice. Folders should be reused, not duplicated, and the second run should not create a second shared folder.
- **Large files.** Files above 8 MiB use upload sessions. Use a file of about 10 MiB to test resumable uploads against the real service.

## 6. Clean up

- Delete the test folders in your Dropbox when you are done.
- Revoke the token: in the App Console, open the app's **Settings** tab and use the option to revoke or regenerate the access token.
- Never commit the token or paste it into an issue or a log. The demo keeps it in memory only.

## What to report back

When something differs from this guide, record:

- the step where it happened;
- the exact error message shown in the result panel or progress list;
- the matching console output from the browser developer tools;
- the Dropbox request ID, if the message includes one.

Each of these findings updates the list of unverified items in `docs/DESIGN.md`.
