# Market research: sales Chrome extensions that export LinkedIn data

Research window: 2026-08-04 to 2026-09-03. Sources: Reddit (r/sales, r/SaaS,
r/chrome_extensions, r/salestechniques, r/b2bmarketing), X, TikTok, GitHub,
and 10 web pages (PhantomBuster, Surfe, RevenueFlow, Hublead, ZoomInfo,
Prospeo, Vayne, Yalc, Clura, dev.to). Raw evidence:
`~/Documents/Last30Days/sales-chrome-extensions-linkedin-export-zoominfo-exportly-raw-v3.md`.

## 1. The landscape

Every commercial extension in this category is a **data business wearing a
Chrome extension as a UI**. The extension itself does three things and the
value is entirely in the third:

| Layer | What it does | Who owns it |
|---|---|---|
| Capture | Read name / title / company / URL from the LinkedIn DOM | Commodity. Every tool does it. |
| Reveal | Look up email + phone in a proprietary database | The moat. ZoomInfo 500M contacts, Apollo 210M, Lusha 280M. |
| Route | Push the record to a CRM / sequencer / Clay | Table stakes, but where reps feel pain. |

The tools people name most (X polls, PhantomBuster's tested ranking, Reddit):

| Tool | Positioning | Extension surface | Destination |
|---|---|---|---|
| Apollo | All-in-one, SMB, public pricing | Profile + Sales Nav bulk (25/page) | Apollo CRM, sequences |
| ZoomInfo (ReachOut) | Enterprise, verified data + intent | Profile + company | ZoomInfo, Salesforce, HubSpot |
| Lusha | Quick lookups, email confidence grade | Profile + Sales Nav bulk view | Salesforce, HubSpot, Pipedrive, Zoho |
| Kaspr | EU/UK phone coverage, budget | Profile, groups, events, search pages | HubSpot, Salesforce, Zoho, Brevo |
| Cognism | Compliance-first, human-verified, DNC checks | Profile + Sales Nav | Salesforce, HubSpot, Outreach |
| Wiza | Bulk Sales Nav extraction, job-change alerts | Sales Nav lists (2,500 cap) | CSV, HubSpot, Salesforce |
| Prospeo / Findymail | Injected "Export Leads" button in Sales Nav | Sales Nav search + lists | CSV |
| Exportly.ai | "The only extension that prospects into Clay tables" | Profile + Sales Nav | Clay, CRM |
| ClayGenies (MIT) | Send selected Sales Nav rows to a Clay webhook | Sales Nav people search only | Any webhook |
| LinkedIn to Zapier | Profile page to any webhook | Profile only | Zapier / Make / webhook |
| Surfe, PhantomBuster, ContactOut, Hunter, Saleshandy, Lemlist | Variants of the above | | |

## 2. Highest-value features, ranked by how often they were cited

1. **One-click capture from the page you are already on.** Every top-10 tool.
   The button must appear on the profile page and on Sales Navigator search
   results without a page reload.
2. **Bulk capture from search results and lead lists.** Sales Navigator has no
   export button on any tier (Surfe). Reps want to select 25 rows on a page and
   send them all. Wiza / Prospeo / Findymail sell this alone.
3. **Push straight into the system of record**, not a CSV. The Hublead and
   Surfe guides both frame CSV as the failure mode: a saved list "is not
   pipeline yet". ClayGenies and Exportly exist purely to skip the CSV step.
4. **Deduplication** by LinkedIn URL so re-sends do not create duplicate CRM
   rows (PhantomBuster's ranking calls this out as table stakes).
5. **Clean, normalized fields.** ClayGenies documents regex cleanup for
   LinkedIn artifacts like "is reachable" appended to names. Downstream tools
   need `first_name` / `last_name` split, company domain, canonical URL.
6. **Safety and rate limits.** Third-party guides converge on 50-100 profile
   captures per day per account as the ceiling before restrictions; bulk
   Sales Nav scraping triggers restrictions fastest; roughly 23% of automation
   users get restricted within 90 days. ClayGenies recommends "single" send
   mode as safer than batch.
7. **Provenance.** Who captured it, from which page, when. Both webhook tools
   send `addedBy` / `sourceUrl` / `sentAt`.
8. **Single-record and batch modes.** Batch for throughput, single for
   downstream tools that key one row per request.
9. **Local-only settings.** "All settings stored in your browser (not on any
   server)" is a selling point for the open-source tools.
10. **Email / phone reveal.** The commercial moat. Out of scope for an
    open-source capture tool; the right design is to send the LinkedIn URL and
    let the receiver (Deepline, Clay) run the enrichment waterfall.

Things nobody praised and several complained about: credit-based reveal
pricing (r/SaaS, @hii_mohit's subscription tally), slow overlays, and CSV
round-tripping.

## 3. What this implies for an open-source extension

- Do the capture and route layers extremely well; leave reveal to the
  receiver.
- Ship one canonical, documented JSON payload with stable field names that
  map 1:1 onto Deepline / Clay / CRM column names.
- Default to single-record sends, with batch available.
- Sign every request (HMAC-SHA256) so the receiver can write to a database
  without trusting the network.
- Dedupe locally by canonical LinkedIn URL, with an override.
- Enforce a configurable daily cap defaulting well under the community ceiling.
- Never call LinkedIn's private Voyager API; read only what is rendered.

## 4. Stats

```
✅ All agents reported back!
├─ 🟠 Reddit: 5 threads │ 59 upvotes │ 111 comments
├─ 🔵 X: 6 posts │ 25 likes │ 11 reposts
├─ 🎵 TikTok: 3 videos │ 538 views │ 11 likes
├─ 🐙 GitHub: 1 repo (Kevin-Davees/LinkedIn-Profile-Scraper)
├─ 🌐 Web: 18 pages — PhantomBuster, Surfe, RevenueFlow, Hublead, ZoomInfo, Prospeo, Vayne, Yalc, Clura, dev.to, ClayGenies
├─ 🗣️ Top voices: @hii_mohit, @allovescloud │ r/SaaS, r/chrome_extensions, r/sales
└─ 📎 Raw results saved to ~/Documents/Last30Days/sales-chrome-extensions-linkedin-export-zoominfo-exportly-raw-v3.md
```
