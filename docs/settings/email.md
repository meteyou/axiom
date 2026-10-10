# Email

Connect IMAP/SMTP mailboxes so the agent can read, search and (optionally) send email on your behalf.

**URL:** `/settings?tab=email`

Email accounts are stored in `/data/config/email-accounts.json` (passwords encrypted at rest). Every account belongs to the user who created it.

## Who sees what

On an instance with several users, email is private per user:

| | Regular user | Admin |
|---|---|---|
| Email tab | Available — own accounts only | Available — lists **all** accounts with an owner column |
| Create accounts | Yes, for themselves | Yes, for themselves |
| Edit an account | Own accounts | Own accounts only. Foreign accounts cannot be edited. |
| Delete an account | Own accounts | Any account (to clean up) |
| Passwords | Never returned by the API | Never returned by the API |
| Sent log | Own entries | All entries (audit) |
| Approve / reject / retry a pending mail | Own mails | **Not** for other users' mails |

The agent follows the same rule, in chat and in background tasks: it only sees and uses the email accounts of the user it is working for. If that user has no account, the email tools are not available at all. Two users may use the same account name; names are unique per user.

Accounts and sent-log entries that existed before multi-user support are attributed to the bootstrap admin (the first account).

## Approval requests

When an account requires approval, or a recipient is not on the allowlist and the account holds such mails for approval, the request goes **only to the account owner**:

- as an interactive message in the owner's web chat, and
- as a prompt in the owner's linked Telegram chat.

Other users, including the admin, never receive the prompt, and their attempts to approve or reject it via chat, API or Telegram are rejected. The same applies to the **Retry** button shown below a failed agent turn: it is only visible to, and only usable by, the owner of that conversation.
