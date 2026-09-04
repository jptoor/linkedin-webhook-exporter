# Audit 3 — NF-01..NF-10 re-review

`npm run typecheck` passed and `npm run lint` passed; receiver and Playwright tests were not run because this sandbox cannot bind ports.

| ID | Verdict | Code and named test verification |
|---|---|---|
| NF-01 | VERIFIED | `src/background/service-worker.ts:466-471` reserves the job row inside `withLock` before tab creation, and `tests/unit/worker.test.ts:134-145` (“five simultaneous EXPORT_START calls create exactly one job and one tab”) asserts one winner and four `job_running` responses. |
| NF-02 | VERIFIED | `src/shared/export-job.ts:155-164` compares origin, path, page, and the canonical non-sensitive query while `src/background/service-worker.ts:422-427` checks job/page/URL echoes, and `tests/unit/audit2.test.ts:8-20` (“accepts the same search… rejects changed filters”) covers the ownership cases. |
| NF-03 | PARTIAL | `receiver/server.mjs:35-40` requires loopback and rejects `NODE_ENV=production`, and `tests/unit/receiver.test.ts:58-63` covers those two cases, but any unset or non-production `NODE_ENV` still enables unsigned mode rather than requiring an explicit development environment. |
| NF-04 | VERIFIED | `receiver/server.mjs:249-259` validates provenance URLs and `receiver/server.mjs:291-297` applies it to import `search_url`, while the named `tests/unit/receiver.test.ts:159-172` (“NF-04/NF-05…”) verifies hostile import provenance is retained as a record without an unsafe URL. |
| NF-05 | VERIFIED | `receiver/server.mjs:220-247` decodes keys case-insensitively, removes the shared sensitive-key list, page, and fragments, and `tests/unit/receiver.test.ts:159-172` verifies `trkInfo`, `midToken`, `sessionId`, and the fragment are absent from persisted search data. |
| NF-06 | PARTIAL | `src/content/parsers/common.ts:52-62` preserves the rendered value in `full_name_raw` when cleaning changes it and `tests/unit/audit2.test.ts:45-54` (“keeps the rendered name…”) verifies that behavior, but `src/shared/normalize.ts:11-32` and `src/shared/normalize.ts:68-80` still apply blanket emoji, credential, and particle heuristics without confidence or locale-aware evidence. |
| NF-07 | PARTIAL | `src/shared/log.ts:49-57`, `src/shared/log.ts:76-84`, and `src/shared/log.ts:87-105` add URL redaction, truncation, a byte loop, and serialized writes, and `tests/unit/audit2.test.ts:23-42` covers URL/log and typical byte limits, but nested objects are stringified without recursive redaction and a single oversized entry can still exceed `LOG_MAX_BYTES`. |
| NF-08 | PARTIAL | `src/content/index.ts:99-100` and `src/content/index.ts:139-142` add a list-mount liveness check, `src/content/ui.ts:115-126` returns a toast disposer, and `src/content/index.ts:301-329` stops export polling after panel removal, but setup awaits and single-page async handlers lack equivalent post-disposal cancellation/generation checks. |
| NF-09 | PARTIAL | `tests/fixtures/generators.mjs:56-78` adds true late row appending and `tests/acceptance/extension.spec.ts:543-554` (“rows appended after scrolling…”) asserts all pages are captured, but the claimed nested-scroller, removed-row/virtualization, no-op-scroll, delayed-after-quiet, and explicit disabled-next cases remain absent. |
| NF-10 | VERIFIED | `src/shared/mapping.ts:49-63` emits the envelope fields in the Deepline row and both `examples/deepline/README.md:35-40` and `docs/SPEC.md:323-330` now document the flat body as beginning with that envelope; no named executable NF-10 test exists, so this verdict is based on the code/document contract comparison. |

## Remaining concrete gaps

- NF-03 needs `NODE_ENV === "development"` (or an equally explicit local-only mode), not merely `!== "production"`, before unsigned startup is considered closed.
- NF-06 still needs a preservation corpus and safer structural/locale-aware cleaning; `full_name_raw` limits loss but does not prevent incorrect `full_name`, `first_name`, or `last_name`.
- NF-07 needs recursive redaction and an explicit policy for dropping/truncating an individual entry that alone exceeds the total byte cap.
- NF-08 needs cancellation or generation checks around every mount/setup await, including single-page mounts and navigation teardown.
- NF-09 needs the remaining realistic scrolling/pagination fixtures and assertions listed above.
- Receiver and acceptance execution remains unverified in this sandbox because their port-binding setup is prohibited.
