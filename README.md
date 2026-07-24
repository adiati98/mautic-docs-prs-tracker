# Mautic Docs PR Tracker 📊

A local JavaScript app that tracks open Mautic docs PRs against their linked code PRs, and tells you — every time you run it — what needs your attention today.

## What It Does

`tracker.js`:
- Fetches open PRs from `mautic/user-documentation` and `mautic/developer-documentation-new`.
- Extracts the linked code PR from each docs PR's description.
- Reads reviews, comments, labels, milestone, and target branch for both the docs PR and its linked code PR.
- Works out whose turn it is on each docs PR — yours, the code author's, or nobody's — and generates `tracker-report.html`, a single self-contained dashboard (dark mode included, no build step, no external assets).
- Filters out bot comments/reviews (dependabot, github-actions, renovate, codecov, mergify).

This tool is **strictly read-only** — it never comments, labels, or merges anything on GitHub. It only tells you what to do next.

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

By default, "the operator" (you) is whoever the token belongs to. If several maintainers share triage duty and you want any of their reviews/reminders to count as "done", list their GitHub logins in `maintainers.json`'s `educationTeam` array (committed, shared by the whole team — not a secret, just usernames):

```json
{
	"educationTeam": ["maintainer1", "maintainer2"]
}
```

The authenticated user (whoever the token belongs to) always counts, whether or not they're listed here.

### 3b. (Optional) Who escalation goes to

When you use GitHub's **Reviewers → Request review** on a docs PR to remind the code PR author, that's picked up automatically — no config needed. Requesting review from specific people or teams instead means "I'm escalating past an unresponsive author," and *that* roster is configurable in the same file, since it's a team decision that changes over time, not something to hard-code:

```json
{
	"educationTeam": ["maintainer1", "maintainer2"],
	"devTeam": ["org/team-slug", "reviewer1"]
}
```

Mix teams and individual logins freely — an entry with a `/` (`org/team-slug`) is matched as a team, a bare login is matched as a person. Requesting review from anyone in this list shows a persistent **"✅ Escalated to `<who>`"** status until they approve (see [Follow-up & escalation timeline](#follow-up--escalation-timeline)). If this key is omitted entirely, it defaults to `["mautic/core-team"]`.

### 4. Run

```bash
node tracker.js
```
(or `npm start`)

This creates `tracker-report.html` — open it in your browser.

## How It Works

Every open docs PR sorts into exactly one of four groups, answering a single question: **whose turn is it?**

1. **Need you today** — something only you can do: review a PR, remind the code author, follow up, escalate to the core team, do a final review and merge, or close a docs PR whose linked code PR was closed without merging.
2. **Bring it forward** — not urgent, but worth doing on your own schedule: brand-new PRs that still need a label or milestone, approvals that are ready to merge with nothing else going on, and anything that's gone quiet for a while (stale).
3. **Waiting on others or for code PR to merge** — you've done your part — either the code PR hasn't merged yet, a reminder to the code PR author has been sent, or you've escalated and are waiting for a reply.
4. **Monitoring** — the author replied and you've already responded; a normal back-and-forth is happening. Collapsed by default, but each row still shows a day count since your last reply — if the conversation goes quiet for a week, it resurfaces in "Need you today" asking you to remind them again.

On top of that, a few extra things can show up on any row, regardless of which group it's in, because they're triggered separately:

- **Remove `pending-pr-merge` label** — the linked code PR merged.
- **Final review, then merge** — someone other than you approved the docs PR (adds a "backport first" step if the PR targets an older release branch).
- **Add `needs-backport` label** — the PR targets a branch older than the repo's latest release branch.
- **Needs rebase** — the docs PR carries a `needs-rebase` label. This is a plain label check, nothing more — it doesn't track how long it's been there. It's there so a rebase-blocked PR never quietly falls out of view.

A docs PR whose linked code PR closed without merging always shows **Close this docs PR** — that one action outranks everything else, since the documented change is dead.

Docs PRs disappear from the report automatically once merged or closed, since only open PRs are fetched.

## Follow-up & escalation timeline

This timeline starts on a reminder to the code PR author, which counts either of two things: a comment that explicitly **@-mentions** them — on either the code PR or the docs PR — or a formal GitHub **Reviewers → Request review** aimed at them on the docs PR. A plain comment or review doesn't start or reset it; it has to be one of those two explicit acts. The @-mention (or request) can be **yours, a teammate's, or Promptless's** (the AI docs bot — the one bot let into this, since it speaks for the docs PR when it relays "I've addressed your feedback" to the code author) — whoever does it is reminding them, and the row names who sent it. This is deliberate: an @-mention or a review request is precise enough to say "someone asked them directly," where a passing comment isn't. It also goes by time, not role — if Promptless's @-mention is the *most recent* one, it's what the row goes by, even if you touched the PR earlier for something unrelated (e.g. a side conversation with Promptless itself) — that touch didn't answer the author, so it doesn't reset anything.

This timeline can't start until the linked code PR has merged (before that, the PR just sits in **Waiting on others** as "Code PR is still open" — no day count). It does **not** wait for you to have formally reviewed the docs PR first — some docs PRs need no content changes at all, so review is skipped by design and you're really just waiting on the code author to confirm things look right. Once merged:

- **No reminder sent yet**: shows "Remind code PR author — code PR merged" — no day count.
- **Day 0–6 since your last reminder**: waiting on others.
- **Day 7**: send a follow-up.
- **Day 14**: escalate to the core team.

If you still haven't formally reviewed the docs PR by the time any of this kicks in, a separate **"Review this docs PR — code PR merged"** label sits alongside whatever this timeline is showing, so that's never lost either.

This timeline stops the moment the code author responds — on either PR, as a comment, review, or approval — and the PR moves to **Need you today** as "Check the author's response." Once you reply (even without reminding them again), it settles into **Monitoring** with its own day count: if that goes quiet for 7 days with no further reply from the author, it resurfaces asking you to send another explicit reminder.

**Escalating early:** Day 14 is when the tool *asks* you to escalate — you don't have to wait for it. The moment you request review from one of the [escalation targets](#3b-optional-who-escalation-goes-to) on the docs PR, the row switches straight to **"✅ Escalated to `<who>`"** in **Waiting on others**, whatever day the clock was on. Unlike the reminder-to-author clock above, a reply doesn't clear this on its own — only an approval (or the code PR closing) does, since escalating is a deliberate call that shouldn't quietly reset itself the moment someone leaves a comment. Any live back-and-forth while it's outstanding still shows up as its own [live human thread](#live-human-threads) row alongside it.

## Live human threads

A docs PR can have a live conversation the timeline above doesn't cover — e.g. a contributor or another maintainer asks a question and nobody's replied. The row shows a **👀 X is waiting on Y** label in whichever group it's currently in (Need you today, Waiting, or Monitoring):

- Waiting on **you** (someone @-mentioned you or a teammate) → orange, sorted high — you owe a reply.
- Waiting on a **third party**, or a comment that doesn't @-mention anyone → blue, just so you can keep an eye on it.
- Waiting on **the code author** — any @-mention of them (yours, a teammate's, or Promptless's) feeds the follow-up timeline above, so once the code PR has merged it's named right in the row's own text ("promptless-for-oss reminded the author, no reply since") rather than a separate label. This label only steps in where the timeline can't yet — mainly before the code PR merges — checked independently of whatever the single most recent comment happens to be about, so a later, unrelated exchange with someone else can't bury it.

## Stale

Independent of any of the above: if neither the docs PR nor its linked code PR has had any activity for more than 30 days, the row gets a dashed **🕸 Stale** badge naming the day count. It's purely an inactivity signal — it doesn't change which group a row is in or its timeline, it just marks rows that have gone quiet for longer than normal, in case something fell through the cracks.

## Approvals

When someone approves a docs PR — you, a teammate, or someone else — the row names them (**approved by …**) in any group. But the actionable **Final review, then merge** step only appears once the linked code PR has merged — while it's still open, the approval is shown as a fact on a waiting row, since you won't merge the docs ahead of the code.

Reviewing a docs PR is optional while its code PR is open (it sits quietly waiting its turn), but becomes **mandatory and prominent** — bumped to orange — the moment the code PR merges.

### Keeping an approval that GitHub dismissed

GitHub automatically removes an approval the moment new commits land on the PR — even when the push only addresses feedback that has nothing to do with the content the approver actually signed off on. Once that happens, the approval disappears from the tracker too: the "Approved by X" label goes away, and everything it unlocked (the "Final review, then merge" step, the escalation shortcut once the code PR merges) reverts as if nobody had approved at all.

If you've checked and the new commits didn't actually touch anything the approver reviewed, add the **`content-approved`** label yourself. The tracker then treats the approval as still standing: the row shows a separate **"Content approved by X — review dismissed"** label (naming the reviewer GitHub's dismissal wiped out), and everything downstream (final review, monitoring, the escalation timeline) behaves as if that approval were still active. It's a deliberate, manual call — never inferred automatically — because only a human can judge whether the new commits actually invalidate the review.

## Author reminder page

`tracker.js` also writes `tracker-reminders.html` — a second, separate page meant to be **shared directly with code PR authors**, not just used by you. Linked from the main dashboard's header (📋 Author reminders) and vice versa.

It lists every docs PR whose linked code PR has **merged** and where the ball is genuinely in the code author's court — grouped into one table per author (bots, including Promptless, are never a "person" here). Each row gets one of two marks:

- **Need review** — nobody's @-mentioned them about this docs PR yet (or the thread went quiet after they last replied).
- **Response to comment from X** — X (you, a teammate, or Promptless) @-mentioned them and they haven't replied since.

This deliberately drops the internal follow-up/escalate urgency language — the same timeline still runs underneath (see above), but this page exists to remind the author, never to tell them they're about to be escalated to the core team.

Each row has a checkbox. Checking it off is saved to **that visitor's own browser only** — nobody else sees it, and it doesn't notify anyone or change anything on GitHub. That's a deliberate tradeoff: it's not synced across devices, and clearing browser data resets it — but it means anyone can open this page and use it right away, with no account needed. The list itself always reflects the real current state regardless of what's checked — a PR drops off automatically once it's actually been handled, whether or not anyone ticked the box.

## Checklist

Every row in Need you today, Bring it forward, and Waiting has a checkbox — Monitoring doesn't, since it's already "nothing to do." Same tradeoff as the reminder page's checkbox (above): it's saved to **your own browser only**, doesn't touch GitHub or anything the tracker computes, and resets if you clear browser data. A checked row dims in place, with its title struck through — the rest of the row's details stay legible so you can still see why it was there.

Each group's header shows a live progress badge (e.g. "2/5 checked"), always counted against the **whole group**, not just whatever the Repo/Priority filters currently show — so it stays a stable "how far am I through this" number instead of shifting under you as you filter. It's grey while untouched, blue while in progress, and turns green with a ✓ once every row in that group is checked off.

A **Hide checked rows** switch sits next to the Repo/Priority filters — it collapses checked rows out of view entirely instead of just dimming them. Your checked state is unchanged either way; it only changes what's shown.

Like the reminder page, checklist entries for PRs no longer on the board are cleared out automatically, so your saved data never grows forever.

## Filtering

The report has two tab strips at the top: filter by **repo** and by **priority** (Critical / Serious / Act / Triage / Stale). Picking a severity tab (Critical–Triage) focuses "Need you today" and hides the calmer Bring it forward / Waiting / Monitoring groups, since severity is a Need-today concept. **Stale** is different — it spans every group, so picking it filters rows *within* Need you today, Bring it forward, Waiting, and Monitoring alike instead of hiding any of them, since a stale PR could be sitting quietly in any of the four. Counts update as you filter; it's all handled in your browser, in the one HTML file.

The four summary tiles at the top are also buttons — click one to jump straight to its section (Monitoring auto-expands, since it's collapsed by default). A "back to top" button appears in the bottom-right corner once you've scrolled past the tiles.

## Caching

Every run writes `data/pr-cache.json` — **committed, not gitignored**, so a scheduled CI run starts warm instead of re-fetching everything from scratch. It's keyed by docs PR; each entry stores the raw reviews/comments for both the docs PR and its linked code PR, alongside the `updated_at` of each at fetch time. On the next run, if neither PR's `updated_at` has moved, the cached data is reused and the 4 heaviest calls per PR (docs reviews/comments, code reviews/comments) are skipped entirely — only the cheap list + code-PR-lookup calls still run, since those are what tell us whether anything changed. The console prints a summary each run, e.g. `📦 cache: 48 reused, 6 fetched`.

This is purely a performance cache: it stores raw API responses, never computed categories, so every category is still recomputed fresh from whatever data (cached or not) is in hand on every run — a caching bug can make a row's *input* stale, never silently corrupt its *category*.

Entries for docs PRs that are no longer open (merged/closed) are pruned automatically. To force a full refetch — e.g. if you don't trust the cache, or changed something upstream — run:
```bash
node tracker.js --fresh
```
or set `TRACKER_NO_CACHE=1`.

## Automation (GitHub Actions + Pages)

`.github/workflows/update-tracker.yml` runs the tracker on a schedule, commits the updated report + cache back to the repo, and publishes both `tracker-report.html` (as the Pages site's `index.html`) and `tracker-reminders.html` to GitHub Pages, each also kept under their own filename in the deployment so the pages' cross-links to each other work the same whether you're viewing them locally or on Pages. Three schedules:

- **Every half hour, 9am–9pm Central European time, Mon–Fri** — incremental (`node tracker.js`, cache-assisted). GitHub Actions cron has no DST support, so each rule is duplicated for CEST and CET (switched via the month field) to keep the same local wall-clock hour year-round. This only leaves drift during the DST transition weeks themselves (late Mar / late Oct), rather than for half the year. Accepted tradeoff for an internal tool.
- **10am and 9pm Central European time on both Saturday and Sunday** — two incremental check-ins each day, same cadence on both weekend days.
- **Midnight Monday Central European time** — a third, extra run specifically for the weekly full resync (`node tracker.js --fresh`), ignoring the cache to correct any drift. Every other run (weekday or weekend) is incremental.

You can also trigger it manually from the Actions tab (`workflow_dispatch`), optionally forcing a fresh fetch via the "Force a full fresh fetch" input.

**Setup** (one-time, see the project's setup notes for the full walkthrough):
1. Create a **fine-grained personal access token** scoped to *Public repositories (read-only)* — this needs no organization approval since it only grants read access to already-public data, and is meaningfully narrower than a classic `public_repo`-scoped token (which also grants write).
2. Add it as a repository secret named `TRACKER_PAT` (Settings → Secrets and variables → Actions).
3. Enable Pages: Settings → Pages → Build and deployment → Source = **GitHub Actions**.

The workflow uses two different tokens for two different jobs, deliberately kept separate: `TRACKER_PAT` (the secret above) is only ever passed to `node tracker.js` for reading the public `mautic/*` repos; the ambient, auto-rotated `GITHUB_TOKEN` GitHub provides per run is what commits and pushes back to *this* repo. Neither token can do the other's job.

## Tips

- **Refresh regularly:** run `node tracker.js` again whenever you want fresh data.
- **Keep your token safe:** never commit it or share it.
- **Formal reviews are unambiguous:** use GitHub's "Review changes" (even just "Comment") when reviewing a docs PR — a plain issue comment is only used as a fallback signal.

## Troubleshooting

**"GITHUB_TOKEN not set"** → You forgot step 2. Set the token in `.env` or your shell.

**"GitHub API error 401"** → Token is wrong or expired. Generate a new one.

**"API error 404"** → Token doesn't have `public_repo` permission. Regenerate it.

---

That's it! Run it whenever you need a quick status check. No installation, no external services, just pure local goodness. 🚀
