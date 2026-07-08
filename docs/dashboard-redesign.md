# Dashboard redesign — design rationale

Companion to [`data-model.md`](data-model.md). Mockup: [`../mockups/dashboard-redesign.html`](../mockups/dashboard-redesign.html) (open in a browser; theme toggle top-right).

## 1. Information hierarchy

The new data model produces ~10 lifecycle categories plus 3 independent flags. Rendering ten
sections would bury the signal, and painting each category a different color would make the
page unreadable. The redesign collapses everything back to **three bands answering one
question — "whose move is it?"** — and pushes the category detail down into per-row chips:

| Band | Membership rule | Feel |
|---|---|---|
| **Need you today** | primary category is operator-actionable (`needs-*`, `blocked-no-code-pr`) **or any flag is lit** | prominent, sorted most-urgent first |
| **Waiting on others** | `waiting-code-pr-merge`, `waiting-code-author-response`, no lit flags | calm; shows the countdown clock |
| **Monitoring** | `monitoring`, no lit flags | collapsed by default |

The "or any flag is lit" rule is the important consequence of the flag model: a PR whose
lifecycle state is "waiting" but which has `finalReviewFlag` lit **is** actionable today, so it
surfaces in the top band with its waiting context intact. Flags never create duplicate rows —
a PR appears exactly once, carrying all its chips.

Within *Need you today*, rows sort by severity, and severity is deliberately a short scale so
red stays meaningful:

1. **Critical** (red) — `needs-escalate-core-team` only. At most a handful of rows can ever be red.
2. **Serious** (orange) — `needs-followup`.
3. **Act** (blue) — remind, review, final-review/merge: normal work, not alarms.
4. **Triage** (gray) — label/milestone housekeeping, `blocked-no-code-pr`.

Each row also gets a right-hand **clock** ("Day 16 · escalate at 14", "Day 3 · follow up at 7")
because the escalation model is time-driven — the day count relative to its threshold is the
single most decision-relevant number per row, so it gets the visual position the old layout
gave to a mostly-empty "Approved By" column.

## 2. Copy

Every category label is a **verb phrase describing the operator's next action**, not an
internal state name. Jargon-free so it works if shared with teammates.

| Category / flag | Chip text | Notes |
|---|---|---|
| `needs-escalate-core-team` | ▲ Escalate to core team | only red chip; icon + label, never color alone |
| `needs-followup` | Send a follow-up | clock shows "Day N · escalate at 14" |
| `needs-remind-code-author` | Ask {author} to review the docs | names the person — the action is social |
| `needs-operator-review` | Review this docs PR | |
| `needs-label-and-milestone` | Add pending-pr-merge label + milestone | any task touching a label names the label |
| `needs-milestone` | Add milestone | |
| `blocked-no-code-pr` | No code PR linked — needs a manual look | states *why* it's stuck |
| `finalReviewFlag` | Final review, then merge | with 10b modifier: "Final review · backport, then merge" |
| `removeLabelFlag` | Remove "pending-pr-merge" label | quotes the literal label name |
| `backportLabelFlag` | Add "needs-backport" label | |
| `waiting-code-author-response` | (meta line) "reminder sent, waiting for a reply" | clock: "Day 3 · follow up at 7" |
| `waiting-code-pr-merge` | (meta line) "you reviewed; reminder goes out once the code PR merges" | explains the *mechanism*, teaching the workflow |
| `monitoring` | (row suffix) e.g. "author responded — reviewing the docs now" | why it's safe to ignore |

Meta line per row replaces four table columns: `Code PR #16265 [Merged] · author mzagmajster ·
approved by RCheesley · targets 5.2 (latest is 6.0)` — facts appear only when they exist,
instead of columns full of `—` and ❌.

## 3. Visual system

- **Tokens** (from the validated data-viz reference palette): status colors critical `#d03b3b`,
  serious `#ec835a`, warning `#fab219`, good `#0ca30c`; accent blue `#2a78d6` (light) /
  `#3987e5` (dark); surfaces `#fcfcfb`/`#f9f9f7` (light), `#1a1a19`/`#0d0d0d` (dark); ink and
  hairline tokens likewise. All defined once as CSS custom properties.
- **Color semantics**: red = deadline passed, orange = deadline approaching, **amber = flag
  chips** (housekeeping to-dos, visually distinct from lifecycle urgency), blue = your normal
  work, gray = triage/waiting. Green appears only as *fact* pills (Merged) and the empty state —
  never as a section color, fixing the old design where "WAITING" screamed green for no reason.
- **Severity edge**: a 4px colored left edge per row gives the scan-column of urgency without
  tinting whole rows (the old full-row red/green washes).
- **Chips vs pills**: rectangular bordered **chips** = actions (things you do); round quiet
  **pills** = facts (Merged / Open / Draft). Two shapes, two meanings.
- **Type**: system sans throughout; `tabular-nums` on day counters; 13–14px body; section
  headers as small uppercase labels instead of colored banner bars.
- Waiting rows get a thin 4px **meter** toward the 7-day follow-up threshold — pre-attentive
  "which one is about to need me."

## 4. Dark mode

Both themes are drawn from the same token table (the palette's light/dark pairs), not a filter:
`prefers-color-scheme` sets the default, a `data-theme` attribute (toggle button) overrides in
both directions. Status hues stay fixed across modes (they're validated for both surfaces);
chip tints are computed with `color-mix()` against the current surface/ink so they re-derive
correctly per mode. Shadows drop in dark; hairline borders carry the elevation instead.

## 5. Empty / success state

When *Need you today* is empty: a green check disc, "Nothing needs you today", plus one line
from a small rotating set ("Inbox zero, docs edition.", …). Rotation is **deterministic by
day** (`floor(now/86400000) % lines.length`) so re-running the generator within a day doesn't
churn the message. A quiet tail line keeps the context: "3 waiting on others · 5 monitoring."
Empty *Waiting*/*Monitoring* sections simply don't render.

## 6. Responsiveness

Single breakpoint at 640px: stat tiles stack into slim horizontal bars; each row's grid
collapses so the clock moves under the chips; chips wrap. No tables anywhere — the row layout
is a CSS grid of prose + chips, so nothing needs horizontal scrolling on a phone.

## Implementation notes (when wiring into `tracker.js`)

- Row model: `{ severity, prTitle+link, metaLine, chips[], clock: {big, small, meterPct?} }` —
  the template stays dumb.
- "Need you today" membership = actionable primary category **or** any lit flag (§1).
- Sort order within the band: escalate → follow-up → final-review/merge → remind → review →
  triage → blocked; ties by day count descending.
- The mockup uses `color-mix()`; fine for a personal tool on any evergreen browser.
