# Mautic Docs PR Tracker 📊

> [!NOTE]
> **👀 Just here to review docs PRs?** You don't need to set anything up. Open the [Docs PR Tracker dashboard](https://adiati98.github.io/mautic-docs-prs-tracker/) and read the [tracker guide](https://adiati98.github.io/mautic-docs-prs-tracker/tracker-guide.html) to learn how to use it.
>
> This README is for people setting up or maintaining the tool itself.

---

A local Node.js script that tracks open Mautic docs PRs and generates a dashboard showing what needs attention.

The script fetches open PRs from Mautic's user documentation and developer documentation repos. Most docs PRs link to a code PR they document. Some are standalone. Either way, the script works out whose turn it is to act — the reviewer, the code author, or nobody right now. This helps the Education Team, and anyone who wants to help review docs PRs, know what to do next.

It writes three HTML files:

- `tracker-report.html` — the main dashboard.
- `tracker-reminders.html` — a page you can share directly with code PR authors, showing what's waiting on them.
- `tracker-guide.html` — the full guide to using the dashboard.

Each file is self-contained: no server, no build step, just open it in a browser.

The tool is **read-only**. It never comments, labels, or merges anything on GitHub. It only reads data and reports on it.

## Tech stack

- **Node.js** (v22 in CI) — no framework, no npm dependencies. `tracker.js` uses only Node's built-in `https` and `fs` modules to call the GitHub REST API and write files.
- **Vanilla HTML/CSS/JS** for the generated dashboards — everything is inlined into the output files, so they run in a browser with no server and no build step.
- **GitHub Actions** for scheduling, running the tracker automatically, committing the results, and deploying to GitHub Pages.

## Setup and run locally

### 1. Get a GitHub token

- Go to https://github.com/settings/tokens
- Click "Generate new token" (classic)
- Check only: `public_repo` (read access)
- Copy the token

### 2. Set the token

Create a `.env` file in the project root:

```
GITHUB_TOKEN="your_token_here"
```

or export it in your shell:

```bash
export GITHUB_TOKEN="your_token_here"
```

### 3. (Optional) Configure maintainers

`maintainers.json` controls two things:

- `educationTeam` — GitHub logins of maintainers who share triage duty. Any of their reviews/reminders count as "done," on top of whoever the token belongs to.
- `devTeam` — logins or `org/team-slug` entries that count as an escalation target, used when the tracker recognizes a review request as "escalated to the Core Team." Defaults to `["mautic/core-team"]` if omitted.

```json
{
	"educationTeam": ["maintainer1", "maintainer2"],
	"devTeam": ["org/team-slug", "reviewer1"]
}
```

This file is committed and shared by the whole team — it holds usernames, not secrets.

### 4. Run

```bash
node tracker.js
```

or:

```bash
npm start
```

This creates `tracker-report.html` and `tracker-reminders.html` — open either in your browser.

To force a full refetch and ignore the cache:

```bash
node tracker.js --fresh
```

or set `TRACKER_NO_CACHE=1`.

### Caching

Every run writes `data/pr-cache.json` (committed, not gitignored). It's keyed by docs PR and stores the raw GitHub API responses for both the docs PR and its linked code PR, along with each one's `updated_at` at fetch time. If nothing has changed since the last run, the cached data is reused and the heaviest API calls are skipped. This is a performance cache only — it never stores computed results, so every category shown on the dashboard is still recalculated fresh on every run.

## Automation (GitHub Actions + Pages)

`.github/workflows/update-tracker.yml` runs the tracker on a schedule, commits the updated report and cache back to the repo, and publishes the dashboard to GitHub Pages. All times below are Central European local time.

- **Every 30 minutes, ~9am–9pm, Monday–Friday** — a regular run, reusing the cache.
- **~10am and ~9pm, Saturday and Sunday** — two runs a day on weekends.
- **~Midnight Monday** — one full refetch a week, ignoring the cache to correct any drift.

You can also trigger it manually from the Actions tab, with an option to force a full fresh fetch.

**One-time setup for a new deployment:**

1. Create a fine-grained personal access token scoped to *Public repositories (read-only)*.
2. Go to **Settings** > **Secrets and variables** > **Actions**, and add it as a repository secret named `TRACKER_PAT`.
3. Go to **Settings** > **Pages** > **Build and deployment** > Source = **GitHub Actions** to enable Pages.

The workflow uses two separate tokens: `TRACKER_PAT` reads the public `mautic/*` repos, and GitHub's own auto-provided token commits and pushes the result back to this repo.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `GITHUB_TOKEN not set` | Set the token in `.env` or your shell (see [Setup](#setup-and-run-locally)). |
| `GitHub API error 401` | Token is wrong or expired. Generate a new one. |
| `API error 404` | Token doesn't have `public_repo` permission. Regenerate it. |

---

For how to actually use the dashboard day to day, see the [tracker guide](https://adiati98.github.io/mautic-docs-prs-tracker/tracker-guide.html).
