# Privacy

Deepline for LinkedIn (LinkedIn Webhook Exporter) is a browser extension you
run yourself. It has no server of its own and no account of its own. It talks
to Deepline (the app you signed in to) and to any webhook you connect.

## What it reads on LinkedIn

- The page you are looking at, when you click a control in the extension (a
  row pill, the dock, or the side panel): names, headlines, titles,
  companies, locations, profile URLs, Sales Navigator identifiers, and, on
  profile pages, experience, education and the About text.
- The API responses the LinkedIn page itself loads (Sales Navigator
  `sales-api`, Voyager search and profile endpoints). A small script in the
  page context observes those responses passively so the extension can fill
  in what the page does not render, such as a person's public profile link.
  It never sends a request to LinkedIn, never changes one, and ignores every
  other URL. You can turn this off in Settings ("Use LinkedIn's own page
  data"). Read `docs/RISK-REVIEW.md` before relying on it: it is the same
  technique commercial extensions use, and it is against LinkedIn's terms.
- The link Sales Navigator's own "Share search" button copies, so a saved
  search can be forwarded by its shareable URL.

It never reads LinkedIn cookies or session tokens, and never scrolls, pages
or navigates on its own.

## Deepline sign-in

When you sign in to Deepline in a normal tab, the extension is signed in too.
It has no `cookies` permission at all: it asks Deepline's session endpoint
who is signed in, and Chrome attaches your session cookie to that request
and to play runs by itself. The cookie's value is never read into extension
code and never stored. Anything you queue while signed in is tied to that
account and organisation; if you sign out or switch accounts before it is
sent, it fails instead of going out under the other account. Alternatively
you can paste an API key under Advanced; that key is stored in this browser
only.

## Where it sends data

- **Deepline**: the people or searches you push (as play runs), your sign-in
  state check, and, if telemetry is on, anonymous usage events and error
  reports (below).
- **Webhooks you connect**: the people or searches you push, over HTTPS
  (plain HTTP for `localhost` only). Each host is requested as an optional
  permission when you save it.
- **The Deepline web app** (deepline.com) can ask the extension three things:
  whether it is installed, whether you are signed in, and to open the side
  panel. Nothing else, and nothing about the pages you visit.

The operator of a destination (your Deepline workspace, your Clay table,
your own receiver) is a separate data processor.

## Telemetry

On by default, off in Settings. Two kinds:

- Usage events (`installed`, `signed_in`, `destination_connected`,
  `push_queued`, `search_import_started`) with the extension version, browser
  user agent, time zone, a random anonymous id, and your Deepline user and
  org id when signed in. They never contain people from LinkedIn, search
  contents, secrets or page URLs; anything shaped like those is stripped
  before sending. Events go to Segment only if the build was compiled with a
  write key; otherwise they stay in the local history.
- Error reports (message and stack trace of extension errors) to Deepline's
  failure-reporting endpoint, only while you are signed in or use an API key.
- Feature flags are fetched from Deepline as a plain JSON document; the
  extension keeps working with built-in defaults if that fails.

## What it stores locally

In the browser profile's extension storage, never synced:

- your settings, including destinations with their API keys, signing secrets
  and optional auth headers;
- a queue of pending/sent/failed deliveries (bodies are kept until sent, then
  pruned after 24 hours);
- a dedupe map of people you already pushed (default 30 days);
- a history of the last 1,000 actions (pushes, sends, selection changes,
  settings changes, sign-in changes, telemetry events). Secrets are never
  written to it;
- a random anonymous id for telemetry.

In session storage, cleared when the browser closes: the people you have
selected but not yet pushed, Sales Navigator share links captured, and your
Deepline sign-in state (email, org id).

Anyone with access to the browser profile can read these. Treat the profile
as the trust boundary. Clearing the extension's storage (or removing the
extension) deletes everything.

## Permissions

`storage` and `alarms` (settings, queue, retries), `sidePanel` (the panel,
offered on LinkedIn tabs only), `tabs` (so the panel can follow the LinkedIn
tab you are on and relay your clicks to it), LinkedIn hosts,
`code.deepline.com`, and one optional host per webhook. No `cookies`, no
`scripting`, no `<all_urls>`.

## Legal responsibility

You capture only what LinkedIn already shows you, but you are the controller
of what you send downstream. Make sure you have a lawful basis (GDPR/CCPA)
for processing the people you push, and read LinkedIn's User Agreement:
LinkedIn prohibits browser extensions that scrape or automate its service,
including reading its API responses, and may restrict accounts that use
them. This extension's daily cap and dedupe are conveniences, not a
compliance mechanism or a safe harbor. A whole-search import is a single
request that hands the search to your backend; what the backend does with
LinkedIn is its operator's responsibility.
