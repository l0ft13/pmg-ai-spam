# Exchange spam triage

An AI second opinion on the Proxmox Mail Gateway (PMG) spam quarantine, with its
own review screen. It reads the quarantine through the PMG API, asks a model
whether each message is spam, genuine or uncertain, and shows you only the mail
worth a look. You release or delete from the review screen; the app passes that
to PMG and logs the decision.

It sits beside the mail path, never in it. If the app is down, mail flows and
PMG quarantines exactly as before.

**Advisory only.** The app never releases, deletes, whitelists or blocks anything
by itself. The only thing it does unprompted is read the quarantine and store
verdicts. Deleting from the review screen is immediate, with no confirmation.

## How it works

1. Every few minutes the poller lists the PMG spam quarantine for all recipients.
2. New messages are fetched in full and parsed: headers, SPF/DKIM/DMARC results,
   text body, real link targets against their visible text, attachment names.
3. The model returns a verdict, a confidence (0-100), a category and a one-line reason.
4. The review screen splits pending mail into:
   - **Needs review**: genuine, unsure, low-confidence spam, and anything the AI failed on.
   - **Obvious spam**: spam at or above `SPAM_HIDE_CONFIDENCE`. Left to expire in PMG.
   - **History**: what you released or deleted, with what the AI said at the time.
5. Your recent decisions and each sender's release/delete history are fed back
   into later classifications, so it learns what your organisation wants.

## Setup

Requires Node 22+ and MySQL or MariaDB.

```bash
npm install
```

Create the database and a user (the tables are created on first start):

```sql
CREATE DATABASE mailtriage CHARACTER SET utf8mb4;
CREATE USER 'mailtriage'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL ON mailtriage.* TO 'mailtriage'@'localhost';
```

In PMG, add a user for this app under Configuration > User Management with the
**Quarantine Manager** role. It needs nothing more.

Copy `.env.example` to `.env` and fill it in, then:

```bash
npm run build
```

```bash
npm start
```

Open `http://127.0.0.1:8025` and sign in with `WEB_USER` / `WEB_PASSWORD`.

### Running under pm2

```bash
npm run build
```

```bash
pm2 start ecosystem.config.cjs
```

After changing code or `.env`, rebuild and run `pm2 restart exchange-spam-triage`.
`pm2 logs exchange-spam-triage` shows the poll results.

### Choosing the AI

| `AI_PROVIDER` | Where mail goes | Notes |
|---|---|---|
| `anthropic` | Claude API | Needs `ANTHROPIC_API_KEY`. Model set by `ANTHROPIC_MODEL`. |
| `ollama` | Stays on your network | Needs an Ollama server and a pulled model (`OLLAMA_MODEL`). |
| `heuristic` | Nowhere | No AI; verdict from the PMG score. For demos and tests. |

Switching provider only affects mail classified afterwards.

### Trying it without touching PMG

```bash
npm run demo
```

This runs the app against a built-in mock PMG with four made-up messages, an
in-RAM store and no AI. Sign in with `demo` / `demo-password`.

## Security notes

- The review screen can release mail, so it is password protected and listens
  on `127.0.0.1` by default. To reach it from another machine, put it behind a
  reverse proxy with HTTPS rather than exposing the port directly: the sign-in
  is HTTP Basic and is only safe over TLS.
- Mail HTML is untrusted. It is shown only inside a sandboxed frame where scripts
  cannot run and links are switched off. Remote images stay blocked until you
  click "Show remote images" for that message.
- Attachments and the original email download as plain files and are never
  opened in the browser. Quarantined attachments can be malicious.
- "Release + whitelist" and "Delete + blocklist" change PMG's system-wide
  Welcomelist and Blocklist, so the PMG user then needs the Administrator role.
  Whole-domain entries are refused for shared domains such as gmail.com.
- Mail content is hostile input. The model is told to treat it as data, can only
  return a fixed verdict structure, and cannot trigger any action.
- Only metadata, verdicts and decisions are stored in the database. Bodies are
  read live from PMG when you open a message.
- Bodies longer than `BODY_CHAR_LIMIT` characters are cut before classification
  and the model is told so.

## Development

```bash
npm test
```

```bash
npm run dev
```

## Not yet verified

The tests run against a mock PMG. Reading the quarantine and decoding mail have
also been checked against a real PMG. Writing to the real Welcomelist and
Blocklist, the Ollama provider, and the blocking advice from a real model have
not been checked yet.
