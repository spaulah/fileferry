# Why this exists

For more than seventeen years I have worked with SharePoint, starting with SharePoint 2007 on-premises. In that time I have helped large enterprises and small businesses with the same problem, over and over: getting files to the people who need to review them, collecting files back from them, and keeping everything organized while it happens.

On paper, sharing looks simple. In practice, the work is rarely one file going to one person. It is a package. A law firm sends a matter's documents to the client, and selected exhibits to opposing counsel, with different rights for each. An accounting firm sends a year-end workpaper set to the client's finance team, and a tax draft to an outside advisor. A consulting team collects deliverables from a dozen external contributors, and keeps them in one place for its own staff to manage. Each audience sees a different slice, with different permissions, but the people inside the firm have to manage the whole thing together.

SharePoint can do pieces of this. Getting all of it right, reliably, is hard. Permissions have to be granted to external people in the right way. Folders have to exist before files go into them. Large uploads fail halfway. A throttled request returns an error that the browser reports only as "Failed to fetch". A retry after a lost reply creates a duplicate. Invitations can go out to some recipients and not others, and the failure is easy to miss. Teams that try to solve this often write their own customizations, usually inside the SharePoint UI, and that code can become hard to maintain once the people who wrote it move on.

I have seen the same kind of problem before SharePoint. The same collaboration and document-routing needs appeared in IBM Lotus Notes, and the answers were often custom code bolted onto the platform: working well for one team, and fragile for everyone else. The platform changes. The problem does not.

The lesson I keep coming back to is simple. The business logic for sharing belongs in one centralized place. Not in a web part, not in a single button handler, not in a workflow that only one administrator understands. It should be a tested library that decides how a package is laid out, who gets what, what happens when a request fails, and what gets reported back. The screens and the integrations should be thin layers on top of it.

Each time a new client or platform came along, I had to build the same solution again, from the beginning. This project is my attempt to build it once, properly, and make it available to anyone who has the same problem.

The goal is a standard framework that works with the interfaces teams already use, React and SharePoint Framework among them, and with the file platforms those teams already rely on: SharePoint/OneDrive, Dropbox today, with Box and Google Drive planned. The engine is designed to stay the same, while the client and the storage provider change.

If you have fought this problem too, I would like to hear what broke for you. The best way to improve a sharing system is to share the failures.
