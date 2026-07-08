# Design: Corrected Data Model & Escalation Rules for `mautic-docs-prs-tracker`

## 0. Guiding correction (read this first)

The current 3-bucket model conflates two *different kinds* of state:

- **Lifecycle state** — where a docs PR is in the linear triage → review → remind → escalate flow. A PR is in exactly **one** of these at a time.
- **Independent action flags** — cleanup/finishing actions that can become true *regardless of* lifecycle position and can co-occur with any of it: "code PR merged, remove the stale label" (rule 8), "someone else approved, do my final review + merge" (rule 9), and "targets an older branch, needs a backport" (rule 10).

Modeling rules 8, 9, and 10 as *flags* rather than *buckets* is the key structural fix. Trying to force them into a single precedence chain is what makes the current logic collapse (e.g. a PR that is both "overdue for escalation" *and* "code just merged, remove label" can't be represented as one bucket). Your own wording already calls these "a flag" / "a reminder" — so the design treats them as orthogonal booleans layered on top of one primary lifecycle category.

The second key fix is **decoupling the escalation clock from `appMerged` and from `created_at`**. The clock is `now − operatorReminderDate`, and reminders can legitimately happen while the code PR is still open (rule 3, open docs PR) — so escalation must not be gated on the code PR being merged the way the current code does.

---

## 0a. Operator identity (agnostic "I / me / my")

Every rule phrased as "**I** review", "**my** reminder", "approved by someone **other than me**" resolves against a configurable **operator identity**, so the tool behaves correctly no matter who on the team runs it.

```
operatorLogins : Set<string>
  default  = [ getAuthenticatedUser() ]          // whoever's token is running the tool = "me"
  optional = configured list of maintainer logins // team mode: any of us counts as "the operator"
```

- **Solo use:** leave it at the default — the authenticated user *is* the operator.
- **Shared/team use:** set `operatorLogins` to the maintainer team's usernames so a review or reminder posted by *any* maintainer (not just the person running this invocation) is treated as "us." This prevents a teammate's earlier review/reminder from looking un-done just because a different teammate is running the tool today.

Throughout this doc, "authored by the operator" means `operatorLogins.has(login)`. All field names use the `operator*` prefix instead of `my*` to keep this explicit.

---

## 1. Corrected data model (per docs PR)

Each field lists the GitHub API call(s) it derives from. Assume the docs PR is `{docsRepo, docsNumber}`.

| Field | Type | Meaning | Derived from |
|---|---|---|---|
| `docsRepo`, `docsNumber` | string / int | Identity | list call |
| `isDraft` | bool | Docs PR is a draft | `GET /repos/{docsRepo}/pulls?state=open` → `pr.draft` |
| `hasLabel` | bool | Has `pending-pr-merge` | `pr.labels[]` (in the pulls payload) |
| `hasMilestone` | bool | Has a milestone assigned | `pr.milestone !== null` |
| `baseBranch` | string | Branch the docs PR targets | `pr.base.ref` |
| `latestReleaseBranch` | string | Newest release branch in the repo | `GET /repos/{docsRepo}/branches` (once per repo, cached — see §5c) |
| `targetsOlderBranch` | bool | PR targets a branch older than latest | `versionLessThan(baseBranch, latestReleaseBranch)` |
| `hasBackportLabel` | bool | Has `needs-backport` (configurable string) | `pr.labels[]` |
| `docsPrAuthorLogin` | string | Who **opened** the docs PR | `pr.user.login` — **can be anyone** (external contributor, teammate, or an operator); never assumed to be the operator |
| `appPRRepo`, `appPRNumber` | string / int / null | Linked code PR | `extractAppPR(pr.body)` (existing) |
| `appPRAuthor` | string / null | Code PR author (the person to remind) | `GET /repos/{appPRRepo}/pulls/{appPRNumber}` → `user.login` |
| `codeMerged` | bool | Linked code PR merged | same call → `merged` |
| `codeMergedDate` | date / null | When code PR merged | same call → `merged_at` |
| `codeClosed` | bool | Linked code PR closed **without** merging (abandoned) | same call → `state == 'closed' && !merged` |
| `operatorReviewDate` | date / null | First time an operator reviewed the docs PR | `GET .../pulls/{docsNumber}/reviews` (+ issue comments, see §4) |
| `operatorReviewDone` | bool | `operatorReviewDate !== null` | derived |
| `devApproved` | bool | Code PR author **approved the docs PR** | docs PR `reviews` where `user==appPRAuthor && state=='APPROVED'` |
| `approvedByNonOperator` | bool | An `APPROVED` review by anyone **not** in `operatorLogins` | docs PR `reviews` |
| `operatorReminderDate` | date / null | When an operator posted the reminder on the code PR | `GET /repos/{appPRRepo}/issues/{appPRNumber}/comments` (see §2) |
| `codeAuthorResponseDate` | date / null | Author's first response **after** the reminder | code-PR + docs-PR comments/reviews (see §3) |
| `codeAuthorResponded` | bool | `codeAuthorResponseDate !== null` | derived |
| `operatorSawResponse` | bool | An operator commented/reviewed **after** the author's response — i.e. I've already looked | operator comment/review on docs- or code-PR with ts `> codeAuthorResponseDate` (reuses §3 data — no new call) |
| `daysSinceOperatorReminder` | int / null | `now − operatorReminderDate` in days | derived (null if never reminded) |
| `operatorLogins` | Set\<string\> | Who counts as "the operator" | `getAuthenticatedUser()` + optional config (§0a) |

**API calls needed per PR (summary):**
1. List open docs PRs (already done) — draft/labels/milestone/user/body/`base.ref`.
2. `GET code PR` — merged, merged_at, **state** (for `codeClosed`), author.
3. `GET docs PR /reviews` — operator review, dev approval, approval-by-non-operator.
4. `GET docs PR /issues/{n}/comments` — operator review-as-comment fallback + author responses on the docs side.
5. `GET code PR /issues/{n}/comments` — operator reminder + author responses on the code side.

**Once per repo (not per PR):** `GET /repos/{docsRepo}/branches` to compute `latestReleaseBranch` (§5c).

Fields the current code got wrong and should be **removed/replaced**:
- `daysSinceDocsCreated` (anchored on `created_at`) → replaced by `daysSinceOperatorReminder`.
- `codeHasResponse` via `didDevRespondAfter(..., new Date(0))` → replaced by `codeAuthorResponded` anchored on `operatorReminderDate` (§3).
- `docsHasResponse = devApproved || comments.count > 0` → too coarse; split into the specific signals above.

---

## 2. "Operator reminder posted" detection

**Goal:** infer, without any automation writing the comment, that an operator manually reminded the code PR author — and get the date the escalation clock starts.

**Signal:** a comment authored by an operator on the **code PR's issue-comments thread**, posted at or after the moment reminding became appropriate.

**Anchor for "appropriate":** an operator only reminds *after reviewing the docs PR* (rule 3), and for a draft only *after the code PR merged* (rule 4). So:

```
reminderAnchor =
  isDraft ? max(operatorReviewDate, codeMergedDate)
          : operatorReviewDate
```

```
operatorReminderDate = earliest code-PR issue-comment where
    operatorLogins.has(comment.user.login)
    AND comment.created_at >= reminderAnchor
  (else null)
```

**Why the anchor matters:** operators are *not* the code PR author, so almost any comment they leave on someone else's code PR is plausibly a reminder — but anchoring on `reminderAnchor` prevents an unrelated earlier comment from being mistaken for the docs-review reminder. This is the precise fix for the `new Date(0)` bug: never anchor on the epoch.

**Clock start = `operatorReminderDate`.** `daysSinceOperatorReminder = floor((now − operatorReminderDate)/day)`.

**Optional hardening (recommended, zero behavior change required):** include an invisible marker in the reminder comment, e.g. `<!-- docs-review-reminder -->`, and prefer a marked comment when present. The date-anchored heuristic works without it; the marker just eliminates false positives if operators leave unrelated comments on the code PR after reviewing.

---

## 3. "Code PR author responded" detection

**The bug being fixed:** `didDevRespondAfter(..., new Date(0))` returns true if the author *ever* touched their own PR — always true — so "remind"/"escalate" were effectively unreachable. The response must be measured **relative to the reminder**, not to all history.

**Precondition:** `operatorReminderDate !== null`. If no one has reminded, "did they respond" is undefined (N/A), not false — this keeps un-reminded PRs out of the escalation path.

**Signal (a response is *any* of these, whichever is earliest):**
```
codeAuthorResponseDate = earliest of:
  - code-PR issue-comment by appPRAuthor with created_at   > operatorReminderDate
  - code-PR review        by appPRAuthor with submitted_at > operatorReminderDate
  - docs-PR issue-comment by appPRAuthor with created_at   > operatorReminderDate
  - docs-PR review        by appPRAuthor with submitted_at > operatorReminderDate   (includes devApproved)
  (else null)
```

Including the **docs-PR** side matters: rule 6 says "no reply to being tagged" — if the author is @-mentioned they may reply on either PR, and a review/approval on the docs PR is the strongest possible response. Use strict `>` (after) the reminder so the reminder comment itself never counts.

`codeAuthorResponded = codeAuthorResponseDate !== null`. Once true, the PR leaves the escalation path (they're engaged) → `monitoring`.

---

## 4. "Operator's own docs-PR review done" detection (rule 3 trigger)

**Primary signal:** an operator submitted a review on the docs PR.
```
operatorReviewDate = earliest docs-PR review where operatorLogins.has(review.user.login)
                     AND review.state in {COMMENTED, APPROVED, CHANGES_REQUESTED}
```

**Fallback signal:** if an operator "reviews" by leaving a plain issue comment rather than a formal review, also consider:
```
OR earliest docs-PR issue-comment where operatorLogins.has(comment.user.login)
```
Take the earliest of the two. Recommendation: treat the **formal review** as canonical and use GitHub's "Review changes" (even just "Comment") to mark the review, so this signal is unambiguous. `operatorReviewDone = operatorReviewDate !== null`.

Note this is distinct from *approving* — rule 3 fires after *any* operator review, including "Comment" or "Request changes."

---

## 5. Corrected category taxonomy

### 5.0 Plain-language framing — the three bands (read this if you're new)

Nobody should need the precedence table below to use the dashboard. Every PR sorts into one of **three bands**, defined by a single question: **whose turn is it?**

| Band | One-line meaning | Whose turn | Categories / flags inside it |
|---|---|---|---|
| **① Act now** ("Need you today") | Something only an operator can do — triage, review, remind, follow up, escalate, merge, or close a dead PR. | **Yours.** | `needs-close-docs-pr` → "Close this docs PR (code PR abandoned)" · `needs-escalate-core-team` → "Escalate to core team" · `needs-followup` → "Send a follow-up" · `needs-remind-code-author` → "Remind the code author" · `needs-check-author-response` → "Check the author's response" · `needs-operator-review` → "Review this docs PR" · `needs-label-and-milestone` → "Add label + milestone" · `needs-milestone` → "Add milestone" · `blocked-no-code-pr` → "No code PR linked — manual look" · plus the flags: `removeLabelFlag` → "Remove `pending-pr-merge`", `finalReviewFlag` → "Final review, then merge", `backportLabelFlag` → "Add `needs-backport`" |
| **② Waiting on others** | You've done your part; a clock or an event is being watched for you. | **Theirs, and it's on the clock.** | `waiting-code-author-response` → "Waiting for author's reply (follow up at day 7)" · `waiting-code-pr-merge` → "Waiting for the code PR to merge" |
| **③ Monitoring** | The author replied, **you've already looked**, and it's now a normal back-and-forth (or they're reviewing) — nothing for you to do. | **Theirs, no clock.** | `monitoring` → "Author engaged — nothing to do" |

**How to read a row:** the **left-edge colour** = urgency (red overdue → orange due-soon → blue actionable → grey triage); **chips** = *actions you take* (verbs); **pills** = *facts about the PR* (Draft, Merged, Open); the **day counter** on the right = days since your reminder, with the two thresholds baked in — **remind → follow up at day 7 → escalate at day 14**.

The internal category keys and exact triggers below (§5a–§5d) are the *implementation* of these three bands; the bands and plain names above are what a teammate actually reads.

### 5a. Independent action flags (evaluated always; can co-occur with any category)

| Flag | Rule | Trigger | Required fields |
|---|---|---|---|
| `removeLabelFlag` | 8 | `codeMerged && hasLabel` | `codeMerged`, `hasLabel` |
| `finalReviewFlag` | 9 | `approvedByNonOperator` | `approvedByNonOperator` |
| `backportLabelFlag` | 10a | `targetsOlderBranch && !hasBackportLabel` | `targetsOlderBranch`, `hasBackportLabel` |

These render as their own to-do badges ("Remove `pending-pr-merge`", "Final review + merge", "Add `needs-backport`") **in addition to** the primary category. This is what lets, say, "escalation overdue" and "code just merged — remove label" show at the same time, which the current single-bucket model cannot express.

**Backport-before-merge modifier (rule 10b):** when `finalReviewFlag` is true (PR approved by a non-operator) **and** `targetsOlderBranch`, the merge action text changes from *"do final review, approve, merge"* to **"do final review, approve, backport first, then merge."** This is a modifier on the final-review action, not a separate flag — it only ever matters at merge time.

**Flag suppression when the code PR is abandoned:** if `codeClosed` is true, the docs PR is headed for closure, not merge — so `removeLabelFlag`, `finalReviewFlag`, and `backportLabelFlag` are all **suppressed** (a label swap or a merge/backport on a PR you're about to close is noise). The only surfaced action is `needs-close-docs-pr` (§5b, category 1).

### 5b. Primary lifecycle category (exactly one; first match wins)

Precedence is ordered most-urgent/most-actionable first. By construction most rows are mutually exclusive (their preconditions don't overlap); the ordering is a safety net for genuine overlaps.

| # | Category | Rule(s) | Trigger (assuming higher rows didn't match) | Key fields |
|---|---|---|---|---|
| 1 | `needs-close-docs-pr` | 11 | `codeClosed` (linked code PR closed unmerged) | `codeClosed` |
| 2 | `blocked-no-code-pr` | edge | `operatorReviewDone && !appPRNumber` | `operatorReviewDone`, `appPRNumber` |
| 3 | `needs-escalate-core-team` | 7 | `operatorReminderDate && !codeAuthorResponded && daysSinceOperatorReminder >= 14` | `operatorReminderDate`, `codeAuthorResponded`, `daysSinceOperatorReminder` |
| 4 | `needs-followup` | 6 | `operatorReminderDate && !codeAuthorResponded && 7 <= daysSinceOperatorReminder < 14` | same |
| 5 | `needs-remind-code-author` | 3, 5 | `operatorReviewDone && appPRNumber && !operatorReminderDate && reminderAppropriate` where `reminderAppropriate = !isDraft \|\| (isDraft && codeMerged)` | `operatorReviewDone`, `appPRNumber`, `operatorReminderDate`, `isDraft`, `codeMerged` |
| 6 | `needs-check-author-response` | 12 | `codeAuthorResponded && !operatorSawResponse` (author replied to my reminder, I haven't looked yet) | `codeAuthorResponded`, `operatorSawResponse` |
| 7 | `needs-operator-review` | 1, 2 | `hasMilestone && !operatorReviewDone` | `hasMilestone`, `operatorReviewDone` |
| 8 | `needs-label-and-milestone` | 1 | `isDraft && (!hasLabel \|\| !hasMilestone)` | `isDraft`, `hasLabel`, `hasMilestone` |
| 9 | `needs-milestone` | 2 | `!isDraft && !hasMilestone` | `isDraft`, `hasMilestone` |
| 10 | `waiting-code-pr-merge` | 4 | `isDraft && operatorReviewDone && appPRNumber && !codeMerged` | `isDraft`, `operatorReviewDone`, `codeMerged` |
| 11 | `waiting-code-author-response` | 6 (pre-window) | `operatorReminderDate && !codeAuthorResponded && daysSinceOperatorReminder < 7` | `operatorReminderDate`, `daysSinceOperatorReminder` |
| 12 | `monitoring` | — | default; the resting state after `codeAuthorResponded && operatorSawResponse` (you've looked; normal back-and-forth in progress) | — |

**Why `needs-close-docs-pr` sits at the top:** once the linked code PR is closed unmerged, the change it documented is abandoned — every remind/follow-up/escalate/wait/merge path is moot. Closing the docs PR is the single correct action, so it outranks all of them. (`waiting-code-pr-merge` in particular must never keep waiting on a code PR that will never merge.)

### 5c. How each of the 12 rules is satisfied

- **Rule 1** (new draft → label + milestone): `needs-label-and-milestone` (action specifies *both*).
- **Rule 2** (new open → set milestone): `needs-milestone` — fires for **every** new open PR that lacks a milestone (no `pending-pr-merge` label; that label is draft-only). If the PR also targets an older branch, `backportLabelFlag` co-fires (rule 10a), so the triage row shows **both** "Add milestone" and "Add needs-backport".
- **Rule 3** (after operator review of an open PR → remind): `needs-remind-code-author`, `reminderAppropriate` true because `!isDraft`.
- **Rule 4** (draft → wait for code merge, then remind): while waiting, `waiting-code-pr-merge`; once `codeMerged`, `reminderAppropriate` becomes true → flips to `needs-remind-code-author`.
- **Rule 5** (draft→open flip also triggers remind): **falls out of the same condition as rule 3 with no event/transition tracking.** Once the PR is open, reviewed, and `operatorReminderDate` is still null, `needs-remind-code-author` fires. The *derived state* already encodes "should have reminded by now," so we never detect the transition itself — a major simplification over diffing snapshots.
- **Rule 6** (7 days no response → follow up): `needs-followup`.
- **Rule 7** (14 days total no response → escalate to core team): `needs-escalate-core-team`.
- **Rule 8** (code merged → remove label): `removeLabelFlag` (independent).
- **Rule 9** (approved by other → final review + merge): `finalReviewFlag` (independent).
- **Rule 10** (targets older branch → backport):
  - **10a — at open (draft or not):** `backportLabelFlag` reminds to add `needs-backport`. It is independent of milestone/label triage, so on a brand-new PR targeting an older branch it co-occurs with the triage action — shown alongside "Add milestone" (open) or "Add label + milestone" (draft), all in the same setup/triage colour family.
  - **10b — at approval:** the backport-before-merge modifier changes the `finalReviewFlag` action to "backport first, then merge."
  - **`latestReleaseBranch` detection:** list repo branches once, keep names matching a version pattern (`/^\d+\.\d+$/`), pick the semver-max (numeric compare of dot-split parts). `targetsOlderBranch = baseBranch matches the version pattern AND version(baseBranch) < version(latestReleaseBranch)`. A non-version base (`main`, `5.x`, a rolling default branch) is treated as *not older* → no backport reminder. The exact label string (`needs-backport`) and the branch pattern are configuration constants.
- **Rule 11** (linked code PR closed unmerged → close the docs PR): `needs-close-docs-pr`, the highest-precedence category. Triggered by `codeClosed`; suppresses the merge/label flags (§5a).
- **Rule 12** (code author responded to my reminder → I take a look): `needs-check-author-response` (Band ①). Fires while `codeAuthorResponded && !operatorSawResponse`. Once I comment/review after their response (`operatorSawResponse` becomes true), it drops to `monitoring`. This replaces the old behaviour where any author response went straight to `monitoring` — a fresh, unread response is now an action for me, not a silent healthy state.

### 5d. Precedence rationale for tricky co-occurrences
- **Escalation overdue + code just merged + stale label:** primary = `needs-escalate-core-team`; `removeLabelFlag` also lit. Both actions surface. (Impossible in the old model.)
- **Approved by non-operator while awaiting author response:** `finalReviewFlag` lit → merging resolves everything; the primary bucket becomes moot once merged. Because the flag is independent it isn't hidden behind the lifecycle bucket.
- **Approved + targets older branch:** `finalReviewFlag` lit with the backport-before-merge modifier → the surfaced action is "backport first, then merge," preventing a merge that skips the backport.
- **Escalation vs. follow-up:** strictly windowed (`>=14` vs `7..14`) so exactly one matches.
- **Code PR closed while a reminder/escalation was pending:** `needs-close-docs-pr` wins over `needs-escalate-core-team`/`needs-followup`/`waiting-*` — no point chasing a review for an abandoned change; just close the docs PR.
- **Author responded but I haven't looked:** `needs-check-author-response` (Band ①), *not* `monitoring`. If the response was an approval, `finalReviewFlag` also lights up (the "then merge" action) alongside it — both surface, and looking at the response and doing the final review are the same act.
- **New open PR targeting an older branch (worked scenario):** `needs-milestone` (rule 2, category) and `backportLabelFlag` (rule 10a, flag) both fire → the row shows **both** "Add milestone" and "Add needs-backport", in the setup/triage colour family. The same pairing applies to a new **draft** targeting an older branch: `needs-label-and-milestone` + `backportLabelFlag` (three items collapse to two chips: "Add label + milestone" and "Add needs-backport").

---

## 6. Edge cases

**Scope rule (firm, not just a default): a docs PR that is `merged` or `closed` is removed from the tracker entirely** — it must not appear in *any* band or list (not "Act now", not "Waiting", not "Monitoring"). The fetch is `state=open`, so these drop out naturally; do **not** widen the fetch to include them and do **not** add a "closed/merged docs PR" category. The docs PR's own terminal states are simply the end of tracking. (Contrast with the **code** PR's states, which *are* tracked — see the code-PR-closed row below.)

| Edge case | Detection | Handling |
|---|---|---|
| **Linked *code* PR closed unmerged** (abandoned change) | `codeClosed == true` (code PR `state=='closed' && !merged`) | `needs-close-docs-pr` (category 1, top precedence) → action "Close this docs PR". The documented change is dead, so all remind/escalate/wait/merge paths are suppressed, as are the merge/label flags (§5a). Once you close the docs PR, it leaves the tracker by the scope rule above. |
| **No linked code PR at all** | `extractAppPR(body)` → null → `appPRNumber == null` | Before operator review: normal triage/review categories apply. After operator review: `blocked-no-code-pr` (category #2) — no author to remind, so surface as manual-attention rather than silently landing in `monitoring`. Never enters remind/escalate path. |
| **Code PR merged before the docs PR is reviewed** | `codeMerged == true && operatorReviewDone == false` | Primary category stays `needs-operator-review` (or `needs-label-and-milestone`/`needs-milestone` if not yet triaged) — the operator still owes a review. `removeLabelFlag` may independently light up if `hasLabel`; that's correct, the stale label is removable regardless. The eventual reminder anchor `max(operatorReviewDate, codeMergedDate)` resolves to `operatorReviewDate` once reviewed. |
| **Docs PR flips open → back to draft** (rare) | `isDraft == true` on a PR that previously had label/milestone | Re-triage only the *missing* pieces: `needs-label-and-milestone` triggers on `!hasLabel \|\| !hasMilestone`, so a surviving milestone isn't re-demanded. **Do not reset `operatorReminderDate` or the clock** — a reminder already sent stays valid; escalation continues from the original date. (Stateless derivation means there's nothing to reset — every field is recomputed from immutable comment/review history each run.) |
| **Operator never formally "reviews," only comments** | `operatorReviewDate` from formal reviews would be null | Fallback in §4 counts the earliest operator docs-PR issue comment as the review. Prefer formal "Review changes" to keep this unambiguous. |
| **Author commented on code PR long before the reminder** | Old `new Date(0)` matched it | Fixed: `codeAuthorResponded` uses strict `> operatorReminderDate`, and is N/A when `operatorReminderDate` is null. |
| **`latestReleaseBranch` can't be determined** (no version-pattern branches) | branch list yields no `/^\d+\.\d+$/` match | Treat `targetsOlderBranch = false` (fail safe: no false backport reminders). Optionally log a warning so the pattern/config can be corrected. |

---

## 7. Migration notes (what changes in the existing `main()`)

1. Add per-PR fetches for **code-PR issue comments** and **docs-PR reviews + issue comments** (items 3–5 in §1). Today only label + code-PR-merged + docs-PR reviews are read.
2. Add a **once-per-repo** branch fetch to compute `latestReleaseBranch`; read `pr.base.ref` per PR (already in the pulls payload).
3. Replace `daysSinceDocsCreated` with `operatorReminderDate` / `daysSinceOperatorReminder`.
4. Replace `didDevRespondAfter(..., new Date(0))` with the `> operatorReminderDate` logic in §3, and compute `operatorSawResponse` (operator comment/review with ts `> codeAuthorResponseDate`) from the same already-fetched comments/reviews — no extra API call.
5. Read `pr.draft`, `pr.milestone`, `pr.labels` (all already in the pulls payload — no extra call).
6. Introduce `operatorLogins` (§0a): default `[getAuthenticatedUser()]`, optionally a configured maintainer list. Replace every `== me` check with `operatorLogins.has(login)` — this now drives four matches (operator review, operator reminder, approved-by-non-operator exclusion, and the reminder author).
7. Replace the 3-way `if/else` with: compute the three flags + backport modifier (§5a) + the first-match primary category (§5b).
8. Add config constants: `BACKPORT_LABEL = 'needs-backport'`, `PENDING_LABEL = 'pending-pr-merge'`, release-branch pattern, follow-up/escalate thresholds (7 / 14 days).
