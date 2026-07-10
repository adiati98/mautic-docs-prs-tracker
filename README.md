# Mautic Docs PR Tracker 📊

A local JavaScript app that tracks open Mautic docs PRs against their linked
code PRs, and tells you — every time you run it — what needs your attention
today.

## What It Does

`tracker.js`:
- Fetches open PRs from `mautic/user-documentation` and
  `mautic/developer-documentation-new`.
- Extracts the linked code PR from each docs PR's description.
- Reads reviews, comments, labels, milestone, and target branch for both the
  docs PR and its linked code PR.
- Works out whose turn it is on each docs PR — yours, the code author's, or
  nobody's — and generates `tracker-report.html`, a single self-contained
  dashboard (dark mode included, no build step, no external assets).
- Filters out bot comments/reviews (dependabot, github-actions, renovate,
  codecov, mergify).

This tool is **strictly read-only** — it never comments, labels, or merges
anything on GitHub. It only tells you what to do next.

## Setup (1 minute)

### 1. Get a GitHub Token

- Go to: https://github.com/settings/tokens
- Click "Generate new token" (classic)
- Check only: `public_repo` (read access)
- Copy the token

### 2. Set Token

Create a `.env` file in this directory:
```
GITHUB_TOKEN="your_token_here"
```
or export it in your shell:
```bash
export GITHUB_TOKEN="your_token_here"
```

### 3. (Optional) Team mode

By default, "the operator" (you) is whoever the token belongs to. If several
maintainers share triage duty and you want any of their reviews/reminders to
count as "done", list their GitHub logins in `maintainers.json` (committed,
shared by the whole team — not a secret, just usernames):

```json
{
	"maintainers": ["maintainer1", "maintainer2"]
}
```

The authenticated user (whoever the token belongs to) always counts, whether
or not they're listed here.

### 4. Run

```bash
node tracker.js
```
(or `npm start`)

This creates `tracker-report.html` — open it in your browser.

## How It Works

Every open docs PR sorts into exactly one of three bands, answering a single
question: **whose turn is it?**

1. **Need you today** — something only you can do: triage a new PR, review
   it, remind the code author, follow up, escalate to the core team, do a
   final review and merge, or close a docs PR whose linked code PR was
   abandoned.
2. **Waiting on others** — you've done your part; a clock is running
   (follow up at day 7, escalate at day 14 since your reminder). If the
   linked code PR is still open, there's no clock at all yet — it just
   shows **Code PR is still open** until it merges.
3. **Monitoring** — the author replied and you've already looked; a normal
   back-and-forth is happening. Collapsed by default, but each row still
   shows a day count since your last reply — if the conversation goes quiet
   for a week, it resurfaces in "Need you today" asking you to remind them
   again.

On top of that lifecycle state, independent flags can light up on **any**
row, regardless of its band, because they're triggered by separate
conditions:

- **Remove `pending-pr-merge` label** — the linked code PR merged.
- **Final review, then merge** — someone other than you approved the docs PR
  (adds a "backport first" step if the PR targets an older release branch).
- **Add `needs-backport` label** — the PR targets a branch older than the
  repo's latest release branch.
- **Needs rebase** — the docs PR carries a `needs-rebase` label. This is a
  plain label check, nothing more — no clock, no "since when". It's there so
  a rebase-blocked PR never quietly falls out of view.

A docs PR whose linked code PR closed without merging always shows
**Close this docs PR** — that one action outranks everything else, since the
documented change is dead.

Docs PRs disappear from the report automatically once merged or closed,
since only open PRs are fetched.

## Escalation clock

The clock only counts comments that explicitly **@-tag the code PR author**
— on either the code PR or the docs PR. A plain comment or review doesn't
start or reset it; it has to be a comment that literally names them. The tag
can be **yours, a teammate's, or Promptless's** (the AI docs bot — the one
bot let into this, since it speaks for the docs PR when it relays "I've
addressed your feedback" to the code author) — whoever tags the author is
reminding them, so any such tag drives the clock, and the row names who sent
it. This is deliberate: an @-mention is the only signal precise enough to
say "someone asked them directly." It's also chronological, not
role-based — if Promptless's tag is the *most recent* one, it's what the
clock and row text go by, even if you touched the PR earlier for something
unrelated (e.g. a side conversation with Promptless itself) — that touch
didn't answer the author, so it doesn't reset anything.

The clock can't start until the linked code PR has merged (before that, the
PR just sits in **Waiting on others** as "Code PR is still open" — no count).
It does **not** wait for you to have formally reviewed the docs PR first —
some docs PRs need no content changes at all, so review is skipped by
design and you're really just waiting on the code author to confirm things
look right. Once merged:

- **No tag sent yet**: shows "Remind code PR author — code PR merged" — no
  count.
- **Day 0–6 since your last tag**: waiting on others.
- **Day 7**: send a follow-up.
- **Day 14**: escalate to the core team.

If you still haven't formally reviewed the docs PR by the time any of this
kicks in, a separate **"Review this docs PR — code PR merged"** chip sits
alongside whatever the clock is showing, so that's never lost either.

The clock stops the moment the code author responds — on either PR, as a
comment, review, or approval — and the PR moves to **Need you today** as
"Check the author's response." Once you reply (even without tagging them
again), it settles into **Monitoring** with its own day count: if that goes
quiet for 7 days with no further reply from the author, it resurfaces
asking you to send another explicit reminder.

## Live human threads

A docs PR can have a live conversation the clock above doesn't model — e.g.
a contributor or another maintainer asks a question and nobody's replied.
The row shows a **👀 X is waiting on Y** chip in whichever band it's
currently in (Need you today, Waiting, or Monitoring):

- Waiting on **you** (someone @-tagged you or a teammate operator) → orange,
  sorted high — you owe a reply.
- Waiting on a **third party**, or an **untagged** comment → blue, just so
  you can keep an eye on it. No clock.
- Waiting on **the code author** — any @-tag of them (yours, a teammate's,
  or Promptless's) feeds the escalation clock above, so once the code PR
  has merged it's named right in the row's own text ("promptless-for-oss
  reminded the author, no reply since") rather than a separate chip. This
  chip only steps in where the clock can't yet — mainly pre-merge, where
  there's no clock at all — checked independently of whatever the single
  most recent comment happens to be about, so a later, unrelated exchange
  with someone else can't bury it.

## Stale

Independent of any of the above: if neither the docs PR nor its linked code
PR has had any activity for more than 30 days, the row gets a dashed
**🕸 Stale** badge naming the day count. It's purely an inactivity signal —
it doesn't change the category or the clock, just flags rows that have gone
quiet for longer than normal, in case something fell through the cracks.

## Approvals

When someone other than an operator approves a docs PR, the row names them
(**approved by …**) in any band. But the actionable **Final review, then
merge** step only appears once the linked code PR has merged — while it's
still open, the approval is shown as a fact on a waiting row, since you
won't merge the docs ahead of the code.

Reviewing a docs PR is optional while its code PR is open (it sits quietly
in triage), but becomes **mandatory and prominent** — bumped to orange — the
moment the code PR merges.

### Preserving a dismissed approval

GitHub auto-dismisses an `APPROVED` review the moment new commits land on
the PR — even when the push only addresses feedback that has nothing to do
with the content the approver actually signed off on. Once that happens,
the approval disappears from the tracker too: the "Approved by X" chip
goes away, and everything it unlocked (the "Final review, then merge" step,
the escalation-clock shortcut once the code PR merges) reverts as if nobody
had approved at all.

If you've checked and the dismissal was spurious — the new commits didn't
touch anything the approver reviewed — add the **`content-approved`**
label yourself. The tracker then treats the approval as still standing:
the row shows a separate **"Content approved by X — review dismissed"**
chip (naming the reviewer GitHub's dismissal wiped out), and every
downstream flow (final review, monitoring, the escalation clock) behaves
as if that approval were still live. It's a
deliberate, manual call — never inferred automatically — because only a
human can judge whether the new commits actually invalidate the review.

## Author reminder page

`tracker.js` also writes `tracker-reminders.html` — a second, separate page
meant to be **shared directly with code PR authors**, not just used by you.
Linked from the main dashboard's header (📋 Author reminders) and vice versa.

It lists every docs PR whose linked code PR has **merged** and where the
ball is genuinely in the code author's court — grouped into one table per
author (bots, including Promptless, are never a "person" here). Each row
gets one of two marks:

- **Need review** — nobody's tagged them about this docs PR yet (or the
  thread went quiet after they last replied).
- **Response to comment from X** — X (you, a teammate, or Promptless) tagged
  them and they haven't replied since.

This deliberately drops the internal follow-up/escalate urgency language —
the escalation clock still runs the same underneath (see above), but this
page exists to remind the author, never to tell them they're about to be
escalated to the core team.

Each row has a checkbox. Checking it off is saved to **that visitor's own
browser only** (`localStorage`) — it doesn't touch the underlying data or
notify anyone. That's a deliberate tradeoff: it's not synced across devices
and clearing browser data resets it, but it needs no backend or login for a
static, freely-shared page, and the list itself always reflects the real
current state regardless of what's checked — a PR drops off automatically
once it's actually been handled, whether or not anyone ticked the box.

## Filtering

The report has two tab strips at the top: filter by **repo** and by
**priority** (Critical / Serious / Act / Triage / Stale). Picking a severity
tab (Critical–Triage) focuses "Need you today" and hides the calmer
Waiting / Monitoring bands, since severity is a Need-today concept. **Stale**
is different — it spans every band, so picking it filters rows *within*
Need today, Waiting, and Monitoring alike instead of hiding any of them,
since a stale PR could be sitting quietly in any of the three. Counts update
as you filter; it's all client-side in the one HTML file.

The three summary tiles at the top are also buttons — click one to jump
straight to its section (Monitoring auto-expands, since it's collapsed by
default). A "back to top" button appears in the bottom-right corner once
you've scrolled past the tiles.

## Caching

Every run writes `data/pr-cache.json` — **committed, not gitignored**, so a
scheduled CI run starts warm instead of re-fetching everything from
scratch. It's keyed by docs PR; each entry stores the raw reviews/comments
for both the docs PR and its linked code PR, alongside the `updated_at` of
each at fetch time. On the next run, if neither PR's `updated_at` has moved,
the cached data is reused and the 4 heaviest calls per PR (docs
reviews/comments, code reviews/comments) are skipped entirely — only the
cheap list + code-PR-lookup calls still run, since those are what tell us
whether anything changed. The console prints a summary each run, e.g.
`📦 cache: 48 reused, 6 fetched`.

This is purely a performance cache: it stores raw API responses, never
computed categories, so every category is still recomputed fresh from
whatever data (cached or not) is in hand on every run — a caching bug can
make a row's *input* stale, never silently corrupt its *category*.

Entries for docs PRs that are no longer open (merged/closed) are pruned
automatically. To force a full refetch — e.g. if you don't trust the cache,
or changed something upstream — run:
```bash
node tracker.js --fresh
```
or set `TRACKER_NO_CACHE=1`.

## Automation (GitHub Actions + Pages)

`.github/workflows/update-tracker.yml` runs the tracker on a schedule,
commits the updated report + cache back to the repo, and publishes both
`tracker-report.html` (as the Pages site's `index.html`) and
`tracker-reminders.html` to GitHub Pages, each also kept under their own
filename in the deployment so the pages' cross-links to each other work the
same whether you're viewing them locally or on Pages. Two schedules:

- **Every hour, 8am–8pm UK time, Mon–Fri** — incremental (`node tracker.js`,
  cache-assisted). Anchored to GMT; GitHub Actions cron has no DST support,
  so during BST (late Mar–late Oct) these land about an hour later by the UK
  clock. Accepted tradeoff for an internal tool.
- **Sunday 11pm UK/GMT** — the only run that day, a full fresh fetch
  (`node tracker.js --fresh`), ignoring the cache to correct any drift.
  Nothing runs on Saturday.

You can also trigger it manually from the Actions tab (`workflow_dispatch`),
optionally forcing a fresh fetch via the "Force a full fresh fetch" input.

**Setup** (one-time, see the project's setup notes for the full walkthrough):
1. Create a **fine-grained personal access token** scoped to
   *Public repositories (read-only)* — this needs no organization approval
   since it only grants read access to already-public data, and is
   meaningfully narrower than a classic `public_repo`-scoped token (which
   also grants write).
2. Add it as a repository secret named `TRACKER_PAT`
   (Settings → Secrets and variables → Actions).
3. Enable Pages: Settings → Pages → Build and deployment → Source =
   **GitHub Actions**.

The workflow uses two different tokens for two different jobs, deliberately
kept separate: `TRACKER_PAT` (the secret above) is only ever passed to
`node tracker.js` for reading the public `mautic/*` repos; the ambient,
auto-rotated `GITHUB_TOKEN` GitHub provides per run is what commits and
pushes back to *this* repo. Neither token can do the other's job.

## Tips

- **Refresh regularly:** run `node tracker.js` again whenever you want fresh
  data.
- **Keep your token safe:** never commit it or share it.
- **Formal reviews are unambiguous:** use GitHub's "Review changes" (even
  just "Comment") when reviewing a docs PR — a plain issue comment is only
  used as a fallback signal.

## Troubleshooting

**"GITHUB_TOKEN not set"**
→ You forgot step 2. Set the token in `.env` or your shell.

**"GitHub API error 401"**
→ Token is wrong or expired. Generate a new one.

**"API error 404"**
→ Token doesn't have `public_repo` permission. Regenerate it.

---

That's it! Run it whenever you need a quick status check. No installation,
no external services, just pure local goodness. 🚀
