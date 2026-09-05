# Deepline for LinkedIn — UX review

Reviewed for the target user: an SDR or sales rep working in LinkedIn Sales Navigator all day, who expects an embedded panel, a visible shortlist, and one obvious push action. Evidence: the supplied e2e screenshots, `.impeccable.md`, `README.md`, `docs/SPEC.md` sections 3 and 4.2–4.2e, the requested source files, and the acceptance flow.

## Executive read

The product has the right underlying shape: it follows the active LinkedIn tab, keeps a cross-page selection basket, separates manual picks from whole-search import, and pins a dynamic action at the bottom. The best moment is the profile state: **“Push Zoë to SQLite receiver”** tells the rep exactly what will happen.

The experience currently makes reps do too much interpretation at the moments that matter most. “Connect a play,” “Import search,” “Add ticked rows,” “receiver,” “pushed today,” and “resend duplicates” describe implementation concepts or state without consistently answering: *what happens next, where will the people go, and is it done?* The first five fixes should improve outcome clarity and setup handoff, not add more features.

Design health: 29/40. Strong on consistency, visual restraint, and user control; weaker on system status, error recovery, recognition of destination capability, and first-run guidance.

| Heuristic | Score | Read |
|---|---:|---|
| Visibility of system status | 3/4 | Good inline/live status, but search import and play running lack a clear terminal state. |
| Match with the real world | 3/4 | “Push” and “selected” fit sales work; “receiver,” “rows,” and “ticked” do not. |
| User control and freedom | 3/4 | Basket removal and retry are present; destination removal lacks confirmation. |
| Consistency and standards | 3/4 | Panel and dock share the model, but their labels and saved-search recovery diverge. |
| Error prevention | 2/4 | Dedupe/cap guardrails help; search capability and duplicate resend are easy to misunderstand. |
| Recognition over recall | 3/4 | The pinned CTA names the outcome; setup and selection vocabulary still require learning. |
| Flexibility and efficiency | 4/4 | Cross-page picks, native checkbox mirroring, favourites, and whole-search import are strong. |
| Aesthetic and minimalist design | 3/4 | Quiet, restrained, and on-brand; some blank space could become useful state guidance. |
| Error recovery | 2/4 | Retry exists, but failure and in-progress states are not actionable enough for reps. |
| Help and documentation | 3/4 | Empty states teach supported pages, but first-run setup and saved searches need a clearer handoff. |

Visual verdict: pass on the project’s anti-slop direction. The warm paper/plum system is restrained, offline-safe, and deliberately unlike a generic dark/gradient dashboard. The main design risk is not visual originality; it is making a technically sophisticated workflow feel like a simple sales action.

## 1. First-run walkthrough from a rep’s perspective

### Install → find the setup path

1. The rep installs the extension and opens LinkedIn. The dock appears, but the first useful instruction is only in the side panel: **“Open a LinkedIn profile, a Sales Navigator search, a lead list or a lead page. This panel follows the tab you are on.”** That is accurate, but it assumes the rep already knows the panel is the place to configure the destination. On a fresh install, the destination reads **“Connect a play”** and the pinned button reads **“Choose where to send.”** Both are understandable enough, but neither says “set up your destination in Settings.”

   Replace the empty state with: **“Connect a destination before your first push.”** Subtext: **“Choose a Deepline play or webhook in Settings, then come back to LinkedIn.”** Button: **“Open Settings.”** Keep the existing “what page are you on?” guidance below it.

2. Clicking the gear opens Settings in a new tab. The page starts with **“Where your people go”**, then offers **“Connect a play”** and **“Connect a webhook.”** This is a fork between a product-native Deepline concept and an engineering integration. A rep who only wants to send leads into their team’s workflow cannot tell which option their team expects, and a rep who does not have a Deepline account is immediately in a credential form.

   Replace the button labels with **“Use a Deepline play”** and **“Send to another tool”**. Keep **“Webhook”** as a secondary label inside the editor for technical users. Add one sentence above the buttons: **“Ask your RevOps admin which destination to use.”**

### Connect → know the setup worked

3. The play editor asks for **“Deepline API key”**, then **“Load my plays.”** The helper copy **“From your Deepline dashboard under API keys. Stored only in this browser.”** is good privacy reassurance, but the rep still has to know what an API key is and why loading is a separate step. After loading, the success state is just **“4 plays”** and the rep must infer that a play row is now selectable.

   Replace **“Load my plays”** with **“Find my plays”**. On success, use **“Choose a play to send people to”** above the rows and **“4 plays found”** as status. After selection, show **“Ready: Warm intro”** rather than only the technical summary.

4. The editor’s primary action is **“Save”**, while the rep is actually making a destination available to the panel. The screenshot’s destination row exposes **“SQLite receiver · current”** plus a raw URL and **“generic, single.”** That is useful for debugging, not for a rep deciding whether the setup is ready.

   Replace **“Save”** with **“Use this destination”**. In the destination list, show **“Warm intro · ready”** and a quieter **“Deepline play”** badge. Hide the URL, mapping, and batching details behind **“Advanced details.”** Confirmation: **“Ready to push to Warm intro.”**

5. The settings page then drops the rep into fields such as **“Max people per day,” “Default search import size,”** and **“Remember pushed people for (days).”** These are reasonable controls for an owner, but they are not part of first-run completion. The warning beginning **“LinkedIn restricts accounts…”** is a compliance-sensitive recommendation presented as a community rule of thumb; it may be read as product safety assurance.

   Keep the controls, but move them below a collapsed **“Limits and duplicate handling”** section. Replace the warning with: **“These limits help you control volume; they do not make LinkedIn activity compliant or prevent restrictions.”**

### First push on a profile

6. The rep returns to LinkedIn, opens a profile, and sees the side panel: **“This person”**, the name, title/company, and **“Add to selection instead.”** The profile CTA is excellent: **“Push Zoë to SQLite receiver.”** It is one clear action and names both the person and destination.

   The confusing part is the secondary path. “Selection” has not been introduced as a concept, and the label does not say what happens after selecting. Replace it with **“Add Zoë to a list”** or, if the cross-page basket must be named, **“Add Zoë to selection (push later)”**. After the click, confirm **“Zoë added — 1 person ready to push.”**

7. After pushing, the panel shows a Recent row with **“Sent”** and **“now”**, plus **“1 pushed today · 1999 left.”** A webhook request being accepted is not necessarily the same thing as a lead being processed. For a Deepline play, the status becomes **“Running,”** so the same action has two different success vocabularies.

   Use a consistent outcome model: **“Queued” → “Delivered to Warm intro”** for the handoff, with **“Play running”** as a secondary detail when relevant. Replace the footer with **“Daily limit: 1 of 2,000 used”** so the number has meaning.

### Pick across multiple result pages

8. On a search, the dock shows **“Push,” “Select page,”** and **“Import search.”** The screenshot shows the primary button as generic **“Push”**, even though the side panel knows the destination. This loses the strongest piece of product communication and makes the dock feel like a different product from the panel.

   The dock should resolve to **“Push to SQLite receiver”** (or **“Push 6 to SQLite receiver”**) before it is interactive. While settings are loading, use **“Loading destination…”** rather than a generic action.

9. The rep clicks the round **“+”** pills. The affordance is discoverable after one click, but the visual only says “add” until the rep recognizes that a check means selected. The tooltip/title says **“Select for Deepline”**, which introduces an internal brand action instead of the rep’s job.

   Use accessible labels such as **“Select Zoë Ångström”** and **“Remove Zoë Ångström from selection.”** Add a one-time inline hint in the dock: **“Select people with +, then push them together.”**

10. The rep changes pages. The basket correctly survives, but the side-panel header in the supplied screenshot reads **“Selected · 6”** rather than explicitly communicating that the six came from several pages. **“Select this page (10)”** is also easy to mistake for LinkedIn’s native selection state, and **“Clear”** does not say whether it clears the current page or the whole basket.

   Replace the header with **“6 selected across 3 pages”**. Replace **“Select this page (10)”** with **“Add all 10 on this page”** and **“Clear”** with **“Clear selection.”** Keep the toggle state as **“Remove all 10 on this page”** after use.

11. **“Add ticked rows”** is the biggest language miss in the selection flow. “Ticked” is regional and “rows” is an implementation term. The empty-state instruction **“Click + next to anyone on the page, or tick Sales Navigator’s own boxes and press Add ticked.”** makes the rep learn two selection systems at once.

   Replace it with **“Add LinkedIn selections.”** Instruction: **“Select people with Deepline’s + buttons, or use LinkedIn’s checkboxes and choose Add LinkedIn selections.”**

12. The bottom CTA is otherwise excellent: **“Push 6 people to SQLite receiver.”** It is the clearest parity point with lemlist’s pinned action. The secondary **“resend duplicates”** checkbox is useful but too casual for a potentially destructive action.

   Replace it with **“Allow people already sent”** and add a tooltip/help sentence: **“Normally, people you already pushed stay skipped.”**

### Import a whole search

13. The card is headed **“Whole search”** and says **“Import everyone from ‘paged’.”** “Everyone” contradicts the limit control; this is not an all-or-nothing import. The helper **“SQLite receiver fetches the members in the background. No clicking through pages.”** exposes system language (“receiver,” “members”) and does not say when the rep can continue.

   Replace the section title with **“Search import.”** Replace the title with **“Import up to 100 people from ‘paged’.”** Replace the helper with **“Deepline will fetch matching people in the background. You can keep working in LinkedIn.”** Replace **“Import search”** with **“Start search import.”**

14. After clicking, the green message is **“Importing up to 60 people. Results land in SQLite receiver.”** This is better than silent success, and Recent shows **“search: paged · Sending · now.”** But the pinned CTA still reads **“Pick people to push,”** which looks like the import did nothing or failed. There is no progress or clear terminal state for the search job.

   Change the pinned state to **“Search import in progress…”** and show **“Up to 60 people are being fetched for SQLite receiver.”** When the handoff is accepted, use **“Search import started”** and keep a Recent item that can become **“Completed,” “Failed — Retry,”** or **“Already imported.”**

15. If the selected destination cannot accept a search, the panel warns **“[name] does not take a search. Pick a play with a search URL input, or select people instead.”** This is technically precise but still asks the rep to understand “search URL input.” It is also possible to see the Import search action in the dock before discovering the restriction.

   Replace it with **“This destination can receive individual people, not whole searches. Choose a search-ready destination or select people one by one.”** Disable or relabel the dock action to **“Choose a search-ready destination.”**

### Saved search

16. A saved search is the most likely dead end. The panel says **“This is a saved search, so its link only works for you. Get the shareable link first.”** The reason is understandable, but the rep is asked to trust a programmatic action that says **“Asking Sales Navigator for the link…”** and then eventually **“Shareable link ready.”** The latter confirms the state but does not tell the rep what to do next.

   Use a two-step message: **“This saved search is private.”** Then **“Get a shareable link from Sales Navigator so Deepline can import it.”** Button: **“Get shareable link.”** Success: **“Shareable link ready — start the import.”**

17. The dock path is worse: it tells the rep **“This is a saved search. Click Sales Navigator’s ‘Share search’ (bottom left) once, then try again.”** This creates a manual hunt through Sales Navigator and sends the rep back to the same action. The side panel already has the better flow; the dock should hand off to it.

   Replace the dock error with **“Open the side panel to make this saved search importable.”** Clicking it should open the side panel, focus the saved-search card, and leave the rep with one next action.

### End state and history

18. Recent is a useful compact receipt, but the settings History screenshot ends at **“No activity yet.”** in the test state, and the implementation renders a raw ISO log / JSON preview. A rep cannot use that to answer “which people did I send today?” or “why did this fail?”

   Keep the raw export for admins, but make the visible history a human-readable activity list: **“Zoë Ångström — sent to Warm intro — 2m ago,” “Search ‘paged’ — started — 4m ago,”** and **“3 people skipped — already sent.”** Rename **“Download (JSON)”** to **“Download technical log”** and place it under Advanced.

## 2. Ranked findings

| ID | Priority | Screen | What is wrong | Why it matters to a rep | Concrete fix | File / line |
|---|---|---|---|---|---|---|
| UX-01 | P0 | Fresh install / side panel | **“Choose where to send”** is actionable but gives no setup handoff; the empty state only teaches supported pages. | A new rep is blocked before the first value moment and may assume the extension is broken. | Add a first-run destination state with **“Connect a destination before your first push”** and **“Open Settings.”** Keep the CTA as the fallback. | `src/sidepanel/sidepanel.html:157-169, 214-217`; `src/sidepanel/sidepanel.ts:88-93` |
| UX-02 | P0 | Saved search / dock | The dock tells the rep to find Sales Navigator’s **“Share search” (bottom left)** and try again. | This is a dead end when layout changes or the rep does not know the control; it breaks the whole-search job. | Dock action should open the side panel, focus the saved-search card, and use the same **“Get shareable link”** flow. | `src/content/index.ts:322-338`; `src/content/index.ts:340-345` |
| UX-03 | P1 | Search import | **“Whole search”**, **“Import everyone”**, and **“receiver”** are either ambiguous or technical; “everyone” conflicts with a limit. | Reps need to know whether they are selecting visible people or handing the query to a backend. | Use **“Search import”**, **“Import up to N people from this search”**, and **“Deepline will fetch matching people in the background.”** | `src/sidepanel/sidepanel.html:135-145`; `src/sidepanel/sidepanel.ts:195-196` |
| UX-04 | P1 | Search import after click | The success note says **“Importing up to 60 people…”** but the pinned CTA remains **“Pick people to push.”** | The primary state contradicts the visible success state; reps may retry or assume the import was ignored. | Add an explicit `searchImporting` state; pinned bar says **“Search import in progress…”** and Recent shows a lifecycle state. | `src/sidepanel/sidepanel.ts:423-433`; `src/sidepanel/sidepanel.ts:246-265` |
| UX-05 | P1 | Cross-page selection | The supplied panel shows **“Selected · 6”** and **“Clear”**; selection across pages is not explicit and clear scope is ambiguous. | Cross-page selection is the differentiator; uncertainty here creates accidental under-selection or deletion of a good basket. | Use **“6 selected across 3 pages,” “Add all 10 on this page,”** and **“Clear selection.”** | `src/sidepanel/sidepanel.ts:185-190`; `src/sidepanel/sidepanel.html:125-131` |
| UX-06 | P1 | Cross-page selection | **“Add ticked rows”** and **“tick Sales Navigator’s own boxes”** use implementation/regional jargon. | The rep already has a familiar concept—LinkedIn checkboxes. The extension should borrow that language. | Replace with **“Add LinkedIn selections”** and explain the two ways to select in one sentence. | `src/sidepanel/sidepanel.html:131-133` |
| UX-07 | P1 | On-page dock | The screenshot shows generic **“Push”** while the side panel names the destination. The dock initially mounts with the generic label and relabels asynchronously. | The dock is the fastest path; without a destination it does not communicate the consequence of the click. | Mount with a loading label; resolve to **“Push to [destination]”** / **“Push N to [destination]”** before enabling. | `src/content/ui.ts:56-93`; `src/content/index.ts:44-46, 113-116, 197-201` |
| UX-08 | P1 | Saved-search panel | **“Asking Sales Navigator for the link…”** and **“Shareable link ready.”** do not clearly state the next step; dock and panel use different recovery instructions. | Saved-search import is already a special case; inconsistent instructions increase abandonment. | Share one component/copy model: private → get link → **“Link ready — start the import.”** | `src/sidepanel/sidepanel.html:140-142`; `src/sidepanel/sidepanel.ts:418-421, 430-432` |
| UX-09 | P1 | Destination setup | **“Connect a play,” “Deepline API key,” “Load my plays,”** and technical play summaries assume Deepline vocabulary and expose setup mechanics. | First-run setup is a hard prerequisite; a rep may not know whether to choose a play or a webhook, or when setup is complete. | Rename entry points, add RevOps guidance, make play selection explicit, and confirm **“Ready to push to [name].”** | `src/options/options.html:78-99`; `src/options/options.ts:162-199, 212-222` |
| UX-10 | P1 | 300px side panel | The import action row and list heading compete for width: **“Up to [N] people Import search”** and **“Select this page (N) Clear”** can crowd or overflow at the supported minimum. | Sales reps often narrow the side panel; clipped actions turn a core flow into trial and error. | Add a 300px layout mode: stack the import controls, allow heading actions to wrap, and keep the primary button full-width. | `src/sidepanel/sidepanel.html:25, 55-57, 186-201`; `src/sidepanel/sidepanel.html:124-133` |
| UX-11 | P1 | Destination picker | The bottom sheet opens and focuses search, but does not trap focus or restore focus on close. | Keyboard users can lose their place and tab into an obscured layer; fast users get a fragile interaction. | Add dialog focus management, Escape restore, `aria-labelledby`, and an explicit selected destination state. | `src/sidepanel/sidepanel.html:220-226`; `src/sidepanel/sidepanel.ts:158-165, 387-398` |
| UX-12 | P1 | Row pills / accessibility | `setPicked()` changes the visual from **“+”** to **“✓”** but does not update `aria-label`; state is also communicated through color/left accent. | A screen-reader user cannot reliably tell whether a person is selected or how to deselect them. | Update `aria-label` to **“Remove [name] from selection”** when pressed; keep the check and add a non-color status. | `src/content/ui.ts:161-178`; `src/content/content.css:14-17` |
| UX-13 | P2 | Profile / footer | **“Add to selection instead”** assumes a basket mental model, and **“resend duplicates”** is casual and lower-case. | The alternate path is useful but its consequence is unclear; the duplicate override can cause accidental re-sends. | Use **“Add [name] to selection (push later)”** and **“Allow people already sent.”** | `src/sidepanel/sidepanel.html:171-180`; `src/sidepanel/sidepanel.html:214-217` |
| UX-14 | P2 | History / settings | Visible History is a raw technical log and **“No activity yet.”** is not a useful receipt. Remove has no confirmation. | Admins need diagnostics; reps need a human-readable record and safe recovery. | Add a readable activity list, move technical JSON under Advanced, and confirm destination removal. | `src/options/options.html:169-176`; `src/options/options.ts:58-65, 283-300` |

## 3. Benchmark parity

### Where Deepline falls short of lemlist

- lemlist’s search card names the job more directly: **“Batch import all profiles from this search.”** Deepline’s **“Whole search” / “Import everyone”** is less precise because the request is capped and server-side.
- lemlist’s push sheet can search destinations and expose favourites plus enrichment/campaign options. Deepline has a good searchable destination sheet with favourites, but no push-time options for enrichment, field selection, or campaign membership.
- lemlist makes the bulk action and its scope explicit with **“Push all to campaign.”** Deepline’s pinned CTA is equally strong for selected people, but search-import status does not use the same action bar to say what is running.
- lemlist’s **“Remove leads already in any team campaign”** is a team-level safety net. Deepline’s **“resend duplicates”** only communicates browser-local dedupe; it does not answer whether a lead is already in a team workflow.

### Where Deepline falls short of Frontier / Exportly

- The embedded dock is the right pattern, but the supplied screenshot shows generic **“Push”** while the side panel has the destination-aware CTA. Frontier/Exportly’s strength is a single obvious embedded action; Deepline should preserve that simplicity while naming the outcome.
- The dock exposes multiple controls (**“Select page”**, **“Import search”**, and the panel launcher) without a strong visual distinction between “select,” “push,” and “hand off a search.” The controls are useful, but the primary/secondary hierarchy needs to be more explicit.

### Where Deepline exceeds both references

- The cross-page basket is first-class: selections survive navigation, preserve page/search provenance, and can be pushed once. That is a meaningful rep workflow, not just a cosmetic row picker.
- Whole-search import avoids browser pagination and hands the search to the backend in one request. This is the right answer for a rep with a large search.
- Saved-search handling recognizes the private deep-link problem and provides a path to a shareable query rather than silently importing the wrong URL.
- Plays are first-class destinations alongside webhooks, with search capability inferred before the request. The destination picker also supports search and favourites.
- Local-only settings, daily caps, dedupe, recent statuses, retries, and a technical history provide stronger operational guardrails than a minimal export dock.

## 4. Accessibility and small-viewport checks

### Side panel at 300px wide

- The explicit `min-width: 300px` is honest, but the UI should be tested at exactly 300 CSS px, not only at the 380px screenshot width.
- The search-import row is the highest-risk overflow: label + number input + “people” + button are all forced into one flex row. Stack the label/input and make **Start search import** full-width at 300px.
- The `h2` action group can compete with the title. Allow it to wrap or move actions below the heading; do not rely on ellipsis for an action label.
- The pinned bar is structurally correct and should remain visible while `main` scrolls. Keep the CTA full width and preserve its destination-aware wording.
- Long destination names, search names, and lead names ellipsize safely in most places. The CTA itself can still become long; test names such as “Sales Navigator search import” at 300px and allow a two-line button.
- The selected basket can become a very tall list. Keep it scrollable inside `main`, but show the count and the global **Clear selection** action before the list.

### Keyboard and assistive technology

- Good foundation: native buttons/inputs, visible focus outlines, `aria-pressed` on row pills and favourites, live `role=status` messaging, and real labels for form fields.
- Fix the destination sheet as a real dialog: add a labelled heading, focus trap, Escape restore, and selected-state announcement.
- Update row-pill `aria-label` when state changes; a changed glyph alone is not enough.
- Do not make green outlines the only “sent” signal. Add text or an accessible status such as **“Sent”** to the row/dock state.
- The settings page’s destination `Remove` action is destructive and currently has no confirmation or undo.
- The gear is accessible by `aria-label`, but the dock launcher’s label should describe the result consistently: **“Open Deepline side panel.”**

### Dock checks

- At narrow desktop viewports, `right: 20px`, `bottom: 20px`, `min-width: 200px`, and `white-space: nowrap` leave little room for a destination-aware CTA plus count and launcher. Add a compact mode or allow the primary label to wrap.
- The dock may cover LinkedIn’s own bottom-right controls. Provide a low-cost reposition/collapse affordance or move it when it overlaps an interactive element.
- The 26px row pill is smaller than a comfortable touch target. This is desktop-first, but increase the hit area to at least 32px without increasing the visual circle, or provide a larger invisible target.
- The dock’s shadow-root isolation is a real strength against LinkedIn CSS collisions. Preserve it while fixing focus and label semantics.

## 5. Five highest rep-impact changes per hour of work

1. Make the empty state an onboarding handoff: **“Connect a destination before your first push” → “Open Settings.”**
2. Make every dock CTA destination-aware and add an explicit **“Search import in progress…”** state.
3. Rewrite the search-import card around the real job: **“Import up to N people from this search”** and **“Start search import.”**
4. Rename selection language: **“Add LinkedIn selections,” “6 selected across 3 pages,”** and **“Clear selection.”**
5. Unify saved-search recovery: open/focus the side panel, say **“This saved search is private,”** then **“Link ready — start the import.”**

These five changes preserve the current architecture and visual identity while removing the most expensive rep questions: where do I configure this, what exactly will happen, did it start, and how do I know my picks survived?

## Status (applied 2026-09-05, same day)

| Finding | Status |
|---|---|
| UX-01 first-run handoff | Done: "Connect a destination before your first push" card with Open Settings, shown until a destination exists. |
| UX-02 saved search from the dock | Done: the dock no longer sends the rep hunting for "Share search"; it opens the side panel, which owns the "This saved search is private → Get shareable link → Shareable link ready. Start the import." flow. |
| UX-03 search import copy | Done: "Search import", "Import up to N people from “…”" (follows the limit field), "<destination> will fetch matching people in the background. You can keep working in LinkedIn.", "Start search import". |
| UX-04 import state | Done: pinned bar reads "Search import started for <destination>" (20 s) and the card says "Search import started: up to N people are being fetched…". A terminal "Completed" state needs a run-status poll and is not implemented. |
| UX-05 selection header | Done: "6 selected across 3 pages", "Add all 10 on this page" / "Remove all 10 on this page", "Clear selection". |
| UX-06 "ticked rows" | Done: "Add LinkedIn selections" and the rewritten hint. |
| UX-07 dock label | Done: dock mounts as "Loading…" (disabled) and resolves to "Push to <destination>" / "Push 6 to <destination>"; relabels live when the destination changes. |
| UX-08 saved-search copy | Done (see UX-02). |
| UX-09 settings vocabulary | Done: "Use a Deepline play" / "Send to another tool", RevOps hint, "Find my plays", "N plays found", "Choose the play to send people to", "Ready: <play>", "Use this destination", "Ready to push to “<name>”", rows read "<name> · ready". |
| UX-10 300 px layout | Done: import row and heading actions wrap; the pinned button may wrap to two lines. |
| UX-11 picker focus | Done: focus trap, Escape and close restore focus to the chip, `aria-labelledby`. |
| UX-12 pill labels | Done: "Select <first name>" / "Remove <first name> from selection" on both `aria-label` and title; 36 px hit area. |
| UX-13 footer copy | Done: "Add <name> to selection (push later)", "Allow people already sent", "Daily limit: N of M used". |
| UX-14 history / remove | Partly: destination removal now confirms; the human-readable history list is not built (JSON log stays). |
