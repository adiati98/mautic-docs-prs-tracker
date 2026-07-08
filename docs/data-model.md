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
| `operatorReviewDate` | date / null | First time an operator reviewed the docs PR | `GET .../pulls/{docsNumber}/reviews` (+ issue comments, see §4) |
| `operatorReviewDone` | bool | `operatorReviewDate !== null` | derived |
| `devApproved` | bool | Code PR author **approved the docs PR** | docs PR `reviews` where `user==appPRAuthor && state=='APPROVED'` |
| `approvedByNonOperator` | bool | An `APPROVED` review by anyone **not** in `operatorLogins` | docs PR `reviews` |
| `operatorReminderDate` | date / null | When an operator posted the reminder on the code PR | `GET /repos/{appPRRepo}/issues/{appPRNumber}/comments` (see §2) |
| `codeAuthorResponseDate` | date / null | Author's first response **after** the reminder | code-PR + docs-PR comments/reviews (see §3) |
| `codeAuthorResponded` | bool | `codeAuthorResponseDate !== null` | derived |
| `daysSinceOperatorReminder` | int / null | `now − operatorReminderDate` in days | derived (null if never reminded) |
| `operatorLogins` | Set\<string\> | Who counts as "the operator" | `getAuthenticatedUser()` + optional config (§0a) |

**API calls needed per PR (summary):**
1. List open docs PRs (already done) — draft/labels/milestone/user/body/`base.ref`.
2. `GET code PR` — merged, merged_at, author.
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

### 5a. Independent action flags (evaluated always; can co-occur with any category)

| Flag | Rule | Trigger | Required fields |
|---|---|---|---|
| `removeLabelFlag` | 8 | `codeMerged && hasLabel` | `codeMerged`, `hasLabel` |
| `finalReviewFlag` | 9 | `approvedByNonOperator` | `approvedByNonOperator` |
| `backportLabelFlag` | 10a | `targetsOlderBranch && !hasBackportLabel` | `targetsOlderBranch`, `hasBackportLabel` |

These render as their own to-do badges ("Remove `pending-pr-merge`", "Final review + merge", "Add `needs-backport`") **in addition to** the primary category. This is what lets, say, "escalation overdue" and "code just merged — remove label" show at the same time, which the current single-bucket model cannot express.

**Backport-before-merge modifier (rule 10b):** when `finalReviewFlag` is true (PR approved by a non-operator) **and** `targetsOlderBranch`, the merge action text changes from *"do final review, approve, merge"* to **"do final review, approve, backport first, then merge."** This is a modifier on the final-review action, not a separate flag — it only ever matters at merge time.

### 5b. Primary lifecycle category (exactly one; first match wins)

Precedence is ordered most-urgent/most-actionable first. By construction most rows are mutually exclusive (their preconditions don't overlap); the ordering is a safety net for genuine overlaps.

| # | Category | Rule(s) | Trigger (assuming higher rows didn't match) | Key fields |
|---|---|---|---|---|
| 1 | `blocked-no-code-pr` | edge | `operatorReviewDone && !appPRNumber` | `operatorReviewDone`, `appPRNumber` |
| 2 | `needs-escalate-core-team` | 7 | `operatorReminderDate && !codeAuthorResponded && daysSinceOperatorReminder >= 14` | `operatorReminderDate`, `codeAuthorResponded`, `daysSinceOperatorReminder` |
| 3 | `needs-followup` | 6 | `operatorReminderDate && !codeAuthorResponded && 7 <= daysSinceOperatorReminder < 14` | same |
| 4 | `needs-remind-code-author` | 3, 5 | `operatorReviewDone && appPRNumber && !operatorReminderDate && reminderAppropriate` where `reminderAppropriate = !isDraft \|\| (isDraft && codeMerged)` | `operatorReviewDone`, `appPRNumber`, `operatorReminderDate`, `isDraft`, `codeMerged` |
| 5 | `needs-operator-review` | 1, 2 | `hasMilestone && !operatorReviewDone` | `hasMilestone`, `operatorReviewDone` |
| 6 | `needs-label-and-milestone` | 1 | `isDraft && (!hasLabel \|\| !hasMilestone)` | `isDraft`, `hasLabel`, `hasMilestone` |
| 7 | `needs-milestone` | 2 | `!isDraft && !hasMilestone` | `isDraft`, `hasMilestone` |
| 8 | `waiting-code-pr-merge` | 4 | `isDraft && operatorReviewDone && appPRNumber && !codeMerged` | `isDraft`, `operatorReviewDone`, `codeMerged` |
| 9 | `waiting-code-author-response` | 6 (pre-window) | `operatorReminderDate && !codeAuthorResponded && daysSinceOperatorReminder < 7` | `operatorReminderDate`, `daysSinceOperatorReminder` |
| 10 | `monitoring` | — | default; includes `codeAuthorResponded == true` (author is now reviewing) | — |

### 5c. How each of the 10 rules is satisfied

- **Rule 1** (new draft → label + milestone): `needs-label-and-milestone` (action specifies *both*).
- **Rule 2** (new open → milestone only): `needs-milestone`.
- **Rule 3** (after operator review of an open PR → remind): `needs-remind-code-author`, `reminderAppropriate` true because `!isDraft`.
- **Rule 4** (draft → wait for code merge, then remind): while waiting, `waiting-code-pr-merge`; once `codeMerged`, `reminderAppropriate` becomes true → flips to `needs-remind-code-author`.
- **Rule 5** (draft→open flip also triggers remind): **falls out of the same condition as rule 3 with no event/transition tracking.** Once the PR is open, reviewed, and `operatorReminderDate` is still null, `needs-remind-code-author` fires. The *derived state* already encodes "should have reminded by now," so we never detect the transition itself — a major simplification over diffing snapshots.
- **Rule 6** (7 days no response → follow up): `needs-followup`.
- **Rule 7** (14 days total no response → escalate to core team): `needs-escalate-core-team`.
- **Rule 8** (code merged → remove label): `removeLabelFlag` (independent).
- **Rule 9** (approved by other → final review + merge): `finalReviewFlag` (independent).
- **Rule 10** (targets older branch → backport):
  - **10a — at open (draft or not):** `backportLabelFlag` reminds to add `needs-backport`.
  - **10b — at approval:** the backport-before-merge modifier changes the `finalReviewFlag` action to "backport first, then merge."
  - **`latestReleaseBranch` detection:** list repo branches once, keep names matching a version pattern (`/^\d+\.\d+$/`), pick the semver-max (numeric compare of dot-split parts). `targetsOlderBranch = baseBranch matches the version pattern AND version(baseBranch) < version(latestReleaseBranch)`. A non-version base (`main`, `5.x`, a rolling default branch) is treated as *not older* → no backport reminder. The exact label string (`needs-backport`) and the branch pattern are configuration constants.

### 5d. Precedence rationale for tricky co-occurrences
- **Escalation overdue + code just merged + stale label:** primary = `needs-escalate-core-team`; `removeLabelFlag` also lit. Both actions surface. (Impossible in the old model.)
- **Approved by non-operator while awaiting author response:** `finalReviewFlag` lit → merging resolves everything; the primary bucket becomes moot once merged. Because the flag is independent it isn't hidden behind the lifecycle bucket.
- **Approved + targets older branch:** `finalReviewFlag` lit with the backport-before-merge modifier → the surfaced action is "backport first, then merge," preventing a merge that skips the backport.
- **Escalation vs. follow-up:** strictly windowed (`>=14` vs `7..14`) so exactly one matches.

---

## 6. Edge cases

Scope note: the tool fetches **open** docs PRs only. **Merged and closed docs PRs are out of scope** — they simply drop out of the fetch and are not tracked, categorized, or flagged. No special handling needed.

| Edge case | Detection | Handling |
|---|---|---|
| **No linked code PR at all** | `extractAppPR(body)` → null → `appPRNumber == null` | Before operator review: normal triage/review categories apply. After operator review: `blocked-no-code-pr` (category #1) — no author to remind, so surface as manual-attention rather than silently landing in `monitoring`. Never enters remind/escalate path. |
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
4. Replace `didDevRespondAfter(..., new Date(0))` with the `> operatorReminderDate` logic in §3.
5. Read `pr.draft`, `pr.milestone`, `pr.labels` (all already in the pulls payload — no extra call).
6. Introduce `operatorLogins` (§0a): default `[getAuthenticatedUser()]`, optionally a configured maintainer list. Replace every `== me` check with `operatorLogins.has(login)` — this now drives four matches (operator review, operator reminder, approved-by-non-operator exclusion, and the reminder author).
7. Replace the 3-way `if/else` with: compute the three flags + backport modifier (§5a) + the first-match primary category (§5b).
8. Add config constants: `BACKPORT_LABEL = 'needs-backport'`, `PENDING_LABEL = 'pending-pr-merge'`, release-branch pattern, follow-up/escalate thresholds (7 / 14 days).
