# End-to-end run on sample pages

Date: 2026-09-05T02:23:15.062Z  
Extension: test build loaded unpacked in Chromium 151.0.7922.34  
Receiver: signed (LWE) webhook destination, admin-token reads, SQLite  

## Actions

| Page | Action | Result |
|---|---|---|
| settings | connect webhook + test connection + save | Connected; test event accepted 200 |
| /in/jane-doe-123/ (classic profile) | Push, then push again | 1 on the way; second click reported pushed before |
| /in/zoe-angstrom-å/ (2026 layout) | Push from the side panel | 1 on the way · 1998 left today · check: sdui_layout, name_cleaned, experience_grouping_uncertain |
| /search/results/people/?keywords=chief revenue officer (2026 layout) | Select page (9 rows), push | 9 on the way · 1989 left today |
| /sales/search/people?query=paged (3 pages × 25) | Pick 3 + 2 + 1 across pages, push once; Import search (60) | 6 people on the way.; search forwarded |
| /sales/search/people?query=delayed (rows render 250 ms after scroll) | Scroll, select page (7 rows), push | 4 on the way · 3 pushed before · 1979 left today |
| /sales/lists/people/7263 (lead list, 12 messy rows) | Select page, push | 12 on the way · 1967 left today |
| /sales/lead/… (lead page) | Push | 1 on the way · 1966 left today |

## Receiver contents

- leads: 34
- searches: 1
- imports: 7 (manual:1, basket:12, basket:4, basket:6, basket:9, manual:1, manual:1)
- queue items: 35, all sent: true

## Checks

| Check | Result |
|---|---|
| classic profile stored with experience | PASS |
| 2026 profile name cleaned, company + location parsed | PASS |
| 2026 profile carries parse warnings | PASS |
| people search: mononym Cher, unicode 李 小龙, Mary Ann van der Berg | PASS |
| people search: hostile host dropped, nested path dropped | PASS |
| people search: anonymous 'LinkedIn Member' not stored | PASS |
| cross-page picks: 6 people from 3 pages under one basket import | PASS |
| lead list: Cyrillic, Turkish, 'Last, First', injection text stored as text | PASS |
| lead list: hostile company host dropped | PASS |
| lead page: grouped experience (6 entries) and top-card location | PASS |
| search import forwarded once with limit 60 | PASS |
| imports: manual and basket kinds recorded with search names | PASS |
| every request signed and accepted (no failed queue items) | PASS |
| activity log covers captures, basket, sends, settings, destination test, search import | PASS |
| no secrets in the activity log | PASS |

## Activity log kinds

```
{
  "send.ok": 35,
  "send.attempt": 35,
  "capture.queued": 9,
  "capture.requested": 10,
  "basket.sent": 4,
  "basket.added": 9,
  "capture.duplicate": 2,
  "search.saved": 1,
  "settings.saved": 2,
  "destination.test": 1
}
```

Screenshots: e2e-screenshots/