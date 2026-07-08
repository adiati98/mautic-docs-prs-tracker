# Mautic Docs PR Tracker 📊

A local JavaScript app to track your docs PRs and their linked app PRs.

## What It Does

**PR tracker** (`tracker.js`):
- ✅ If app PR is merged
- ✅ If docs PR has human reviews (comments/approvals)
- ✅ Flags docs PRs that need attention (app merged but not reviewed)
- ✅ Shows current labels on each docs PR
- ✅ Filters out bot comments/reviews

## Setup (1 minute)

### 1. Get GitHub Token
- Go to: https://github.com/settings/tokens
- Click "Generate new token" (classic)
- Check only: `public_repo` (read access)
- Copy the token

### 2. Set Token
Run this once in your terminal:

**Mac/Linux:**
```bash
export GITHUB_TOKEN="your_token_here"
```

**Windows (PowerShell):**
```powershell
$env:GITHUB_TOKEN="your_token_here"
```

Or add to your shell profile to make it permanent.

### 3. Run
```bash
node tracker.js
```
(or `npm start`)

This creates `tracker-report.html` - open it in your browser.

## How It Works

1. Fetches all open PRs from both docs repos
2. Extracts linked app PR numbers from descriptions (looks for "mautic/mautic PR #XXXX")
3. Checks if app PRs are merged
4. Counts human reviews (filters out bots like dependabot)
5. Generates an HTML report sorted by priority

Docs PRs disappear from the report automatically once merged, since only open PRs are fetched. App PR status is just informational and isn't filtered the same way.

## What's "Needs Action"?

Red flag (top section):
- App PR is **merged** ✅
- But docs PR is **not reviewed** ❌

→ You should remind the dev to review the docs!

## Dashboard Sections

1. **🚨 Needs Action** - App merged but docs not reviewed (do these first!)
2. **⏳ Pending Merge** - Has `pending-pr-merge` label (waiting for app PR)
3. **✅ Reviewed/In Progress** - Everything else

## Stats Card

Shows at the top:
- Red: PRs needing action
- Yellow: PRs pending app merge
- Purple: Total PRs being tracked

## Tips

- **Refresh regularly:** Just run `node tracker.js` again whenever you want fresh data
- **Keep token safe:** Never commit it or share it
- **Bot filtering:** Automatically ignores comments from: dependabot, github-actions, renovate, codecov, mergify
- **Review = approval + comments:** Counts as reviewed if dev commented OR approved

## Troubleshooting

**"GITHUB_TOKEN not set"**
→ You forgot step 2. Set the token in terminal.

**"GitHub API error 401"**
→ Token is wrong or expired. Generate a new one.

**"API error 404"**
→ Token doesn't have `public_repo` permission. Regenerate it.

---

That's it! Run it whenever you need a quick status check. No installation, no external services, just pure local goodness. 🚀
