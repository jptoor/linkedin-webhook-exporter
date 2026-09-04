# End-to-end run on sample pages

Date: 2026-09-04T13:54:26.135Z  
Extension: test build loaded unpacked in Chromium 151.0.7922.34  
Receiver: signed (LWE), admin-token reads, SQLite  

## Actions

| Page | Action | Result |
|---|---|---|
| options | save + test event | Saved; test event accepted 200 |
| /in/jane-doe-123/ (classic profile) | Send, then send again | Queued 1; second click reported already sent |
| /in/zoe-angstrom-å/ (2026 layout) | Send | Queued 1 · 1998 left today · check: sdui_layout, name_cleaned, experience_grouping_uncertain |
| /search/results/people/?keywords=chief revenue officer (2026 layout) | Select all (9 rows), send, save search | Queued 9 · 1989 left today; search saved |
| /sales/search/people?query=paged (3 pages × 25) | Export all, limit 60 | done (limit); pages 3, collected 60, sent 60, skipped 0 |
| /sales/search/people?query=delayed (rows render 250 ms after scroll) | Export all, limit 25 | done (limit); collected 25, sent 0, skipped 25 (already sent from the paged export) |
| /sales/lists/people/7263 (lead list, 12 messy rows, no Next) | Export all | done (no_more_pages); collected 12, sent 12 |
| /sales/lead/… (lead page) | Send | Queued 1 · 1916 left today |

## Receiver contents

- leads: 84
- searches: 4
- imports: 6 (manual:1, export:12, export:60, manual:9, manual:1, manual:1)
- queue items: 88, all sent: true

## Checks

| Check | Result |
|---|---|
| classic profile stored with experience | PASS |
| 2026 profile name cleaned, company + location parsed | PASS |
| 2026 profile carries parse warnings | PASS |
| people search: mononym Cher, unicode 李 小龙, Mary Ann van der Berg | PASS |
| people search: hostile host dropped, nested path dropped | PASS |
| people search: anonymous 'LinkedIn Member' not stored | PASS |
| paged export: 60 distinct Sales Nav URLs | PASS |
| lead list: Cyrillic, Turkish, 'Last, First', injection text stored as text | PASS |
| lead list: hostile company host dropped | PASS |
| lead page: grouped experience (6 entries) and top-card location | PASS |
| searches: people search + paged + delayed + list saved | PASS |
| imports: manual and export kinds recorded with search names | PASS |
| every request signed and accepted (no failed queue items) | PASS |
| activity log covers captures, sends, exports, settings, search saves | PASS |
| no secrets in the activity log | PASS |

## Activity log kinds

```
{
  "send.ok": 88,
  "send.attempt": 88,
  "capture.queued": 8,
  "capture.requested": 10,
  "export.finished": 3,
  "export.page": 5,
  "export.started": 3,
  "search.saved": 4,
  "capture.duplicate": 2,
  "webhook.test": 1,
  "settings.saved": 1
}
```

Screenshots: e2e-screenshots/