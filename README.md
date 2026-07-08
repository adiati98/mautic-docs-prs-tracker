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
count as "done", add their GitHub logins to `.env`:
```
OPERATOR_LOGINS="maintainer1,maintainer2"
```
The authenticated user always counts, whether or not this is set.

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

On top of that lifecycle state, three independent flags can light up on
**any** row, regardless of its band, because they're triggered by separate
conditions:
- **Remove `pending-pr-merge` label** — the linked code PR merged.
- **Final review, then merge** — someone other than you approved the docs PR
  (adds a "backport first" step if the PR targets an older release branch).
- **Add `needs-backport` label** — the PR targets a branch older than the
  repo's latest release branch.

A docs PR whose linked code PR closed without merging always shows
**Close this docs PR** — that one action outranks everything else, since the
documented change is dead.

Docs PRs disappear from the report automatically once merged or closed,
since only open PRs are fetched.

## Escalation clock

The clock only counts comments that explicitly **@-tag the code PR author**
— on either the code PR or the docs PR. A plain comment or review doesn't
start or reset it; it has to be a comment that literally names them. The tag
can be **yours or a teammate's** (anyone who isn't the code author) — whoever
tags the author is reminding them, so any such tag drives the clock, and the
row names who sent it. This is deliberate: an @-mention is the only signal
precise enough to say "someone asked them directly."

The clock can't start until the linked code PR has merged (before that, the
PR just sits in **Waiting on others** as "Code PR is still open" — no count).
Once merged and reviewed:

- **No tag sent yet**: shows "Remind the code author" — no count.
- **Day 0–6 since your last tag**: waiting on others.
- **Day 7**: send a follow-up.
- **Day 14**: escalate to the core team.

The clock stops the moment the code author responds — on either PR, as a
comment, review, or approval — and the PR moves to **Need you today** as
"Check the author's response." Once you reply (even without tagging them
again), it settles into **Monitoring** with its own day count: if that goes
quiet for 7 days with no further reply from the author, it resurfaces
asking you to send another explicit reminder.

## Live human threads

A docs PR can have a live conversation the clock above doesn't model — e.g.
a contributor or another maintainer asks a question and nobody's replied.
When the most recent human comment on a docs PR is unanswered, the row shows
a **👀 X is waiting on Y** chip and surfaces in **Need you today**:

- Waiting on **you** (someone @-tagged you or a teammate operator) → orange,
  sorted high — you owe a reply.
- Waiting on a **third party**, or an **untagged** comment → blue, just so
  you can keep an eye on it. No clock (an @-tag of *the code author*, by
  contrast, feeds the escalation clock above instead).

## Approvals

When someone other than an operator approves a docs PR, the row names them
(**approved by …**) in any band. But the actionable **Final review, then
merge** step only appears once the linked code PR has merged — while it's
still open, the approval is shown as a fact on a waiting row, since you
won't merge the docs ahead of the code.

Reviewing a docs PR is optional while its code PR is open (it sits quietly
in triage), but becomes **mandatory and prominent** — bumped to orange — the
moment the code PR merges.

## Filtering

The report has two tab strips at the top: filter by **repo** and by
**priority** (Critical / Serious / Act / Triage). Picking a specific
priority focuses "Need you today" and hides the calmer Waiting / Monitoring
bands. Counts update as you filter; it's all client-side in the one HTML
file.

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
