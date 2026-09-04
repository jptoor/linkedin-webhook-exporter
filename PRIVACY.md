# Privacy

LinkedIn Webhook Exporter is a browser extension you run yourself. It has no
server, no account, and no telemetry.

## What it reads

Only the LinkedIn page you are looking at, when you click a control in the
extension's panel (or run a bulk export you started). It reads the rendered
DOM: names, headlines, titles, companies, locations, profile URLs, Sales
Navigator identifiers, and, on profile pages, experience, education and the
About text. It never calls LinkedIn's private APIs and never reads LinkedIn
cookies or session tokens.

## Where it sends data

Only to the webhook URL you configure, over HTTPS (plain HTTP is allowed for
`localhost` only). The host is requested as an optional permission when you
save it. The operator of that webhook (your Deepline workspace, your Clay
table, your own receiver) is a separate data processor; this extension does
not control what they do with the data.

## What it stores locally

In the browser profile's extension storage, never synced:

- your settings, including the signing secret and optional auth header;
- a queue of pending/sent/failed deliveries (bodies are kept until sent, then
  pruned after 24 hours);
- a dedupe map of lead identities you already sent (default 30 days);
- an activity log of the last 1,000 actions (captures, sends, exports,
  settings changes). Secrets are never written to the log.

Anyone with access to the browser profile can read these. Treat the profile
as the trust boundary. Clearing the extension's storage (or removing the
extension) deletes everything.

## Legal responsibility

You capture only what LinkedIn already shows you, but you are the controller
of what you send downstream. Make sure you have a lawful basis (GDPR/CCPA)
for processing the people you capture, and read LinkedIn's User Agreement:
LinkedIn prohibits browser extensions that scrape or automate its service
and may restrict accounts that use them. This extension's daily cap, pacing,
and dedupe are conveniences, not a compliance mechanism or a safe harbor.
