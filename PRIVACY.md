# Privacy

Deepline for LinkedIn (LinkedIn Webhook Exporter) is a browser extension you
run yourself. It has no server of its own, no account of its own, and no
telemetry.

## What it reads

Only the LinkedIn page you are looking at, when you click a control in the
extension (a row pill, the dock, or the side panel). It reads the rendered
DOM: names, headlines, titles, companies, locations, profile URLs, Sales
Navigator identifiers, and, on profile pages, experience, education and the
About text. It never calls LinkedIn's private APIs, never reads LinkedIn
cookies or session tokens, and never scrolls, pages or navigates on its own.

One small script runs in the page context: it observes the link that Sales
Navigator's own "Share search" button copies to the clipboard, so a saved
search can be forwarded by its shareable URL. It forwards only text that
looks like a Sales Navigator search URL and nothing else.

## Where it sends data

Only to the destinations you connect:

- a **Deepline play**, run through Deepline's API at the address you set
  (`https://code.deepline.com` by default) with the API key you paste;
- a **webhook URL** you configure, over HTTPS (plain HTTP is allowed for
  `localhost` only).

Each host is requested as an optional permission when you save it. The
operator of the destination (your Deepline workspace, your Clay table, your
own receiver) is a separate data processor; this extension does not control
what they do with the data.

## What it stores locally

In the browser profile's extension storage, never synced:

- your settings, including destinations with their API keys, signing secrets
  and optional auth headers;
- a queue of pending/sent/failed deliveries (bodies are kept until sent, then
  pruned after 24 hours);
- a dedupe map of people you already pushed (default 30 days);
- a history of the last 1,000 actions (pushes, sends, selection changes,
  settings changes). Secrets are never written to it.

In session storage, cleared when the browser closes: the people you have
selected but not yet pushed, and any Sales Navigator share links captured.

Anyone with access to the browser profile can read these. Treat the profile
as the trust boundary. Clearing the extension's storage (or removing the
extension) deletes everything.

## Permissions

`storage` and `alarms` (settings, queue, retries), `sidePanel` (the panel),
`tabs` (so the panel can follow the LinkedIn tab you are on and relay your
clicks to it), LinkedIn hosts, and one optional host per destination.

## Legal responsibility

You capture only what LinkedIn already shows you, but you are the controller
of what you send downstream. Make sure you have a lawful basis (GDPR/CCPA)
for processing the people you push, and read LinkedIn's User Agreement:
LinkedIn prohibits browser extensions that scrape or automate its service
and may restrict accounts that use them. This extension's daily cap and
dedupe are conveniences, not a compliance mechanism or a safe harbor. A
whole-search import is a single request that hands the search to your
backend; what the backend does with LinkedIn is its operator's
responsibility.
