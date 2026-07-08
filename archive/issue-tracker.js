#!/usr/bin/env node

const https = require("https")
const fs = require("fs")

// Load .env file if it exists
if (fs.existsSync(".env")) {
	const envContent = fs.readFileSync(".env", "utf8")
	envContent.split("\n").forEach((line) => {
		const trimmed = line.trim()
		if (trimmed && !trimmed.startsWith("#")) {
			const [key, ...valueParts] = trimmed.split("=")
			const value = valueParts
				.join("=")
				.trim()
				.replace(/^["']|["']$/g, "")
			if (key && key.trim()) {
				process.env[key.trim()] = value
			}
		}
	})
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const REPOS = [
	"mautic/developer-documentation-new",
	"mautic/user-documentation",
	"mautic/mautic-community-handbook",
	"mautic/low-no-code",
]

const BOTS = ["dependabot", "github-actions", "renovate", "codecov", "mergify"]

const REPO_INFO = {
	"mautic/developer-documentation-new": {
		label: "Developer Docs",
		color: "#0969da",
	},
	"mautic/user-documentation": { label: "User Docs", color: "#1a7f37" },
	"mautic/mautic-community-handbook": {
		label: "Community Handbook",
		color: "#9a6700",
	},
	"mautic/low-no-code": { label: "Low-Code/No-Code", color: "#8250df" },
}

function getRepoInfo(repo) {
	return REPO_INFO[repo] || { label: repo.split("/")[1], color: "#57606a" }
}

function makeRequest(url) {
	return new Promise((resolve, reject) => {
		const options = {
			headers: {
				Authorization: `token ${GITHUB_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Mautic-Issue-Tracker",
			},
		}

		https
			.get(url, options, (res) => {
				let data = ""
				res.on("data", (chunk) => (data += chunk))
				res.on("end", () => {
					if (res.statusCode >= 400) {
						reject(new Error(`GitHub API error ${res.statusCode}: ${data}`))
					} else {
						resolve(JSON.parse(data))
					}
				})
			})
			.on("error", reject)
	})
}

async function getAuthenticatedUser() {
	try {
		const user = await makeRequest("https://api.github.com/user")
		return user.login
	} catch (e) {
		console.error("Could not get authenticated user:", e.message)
		return null
	}
}

async function getOpenIssues(repo) {
	try {
		const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`
		const items = await makeRequest(url)
		return items.filter((item) => !item.pull_request)
	} catch (e) {
		console.error(`Error fetching issues from ${repo}:`, e.message)
		return []
	}
}

async function getComments(repo, issueNumber) {
	try {
		const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`
		return await makeRequest(url)
	} catch (e) {
		console.error(
			`Error fetching comments for ${repo}#${issueNumber}:`,
			e.message,
		)
		return []
	}
}

async function main() {
	if (!GITHUB_TOKEN) {
		console.error("❌ GITHUB_TOKEN environment variable not set")
		process.exit(1)
	}

	console.log("🔍 Getting your GitHub username...")
	const username = await getAuthenticatedUser()
	if (!username) {
		console.error("❌ Could not get GitHub username from token")
		process.exit(1)
	}
	console.log(`✅ Tracked as: ${username}\n`)

	console.log("📊 Fetching open issues...")
	const allIssues = []
	for (const repo of REPOS) {
		console.log(`  Scanning ${repo}...`)
		const issues = await getOpenIssues(repo)
		allIssues.push(...issues.map((issue) => ({ ...issue, sourceRepo: repo })))
	}
	console.log(`Found ${allIssues.length} open issues\n`)

	const issueData = []
	for (let i = 0; i < allIssues.length; i++) {
		const issue = allIssues[i]
		process.stdout.write(`\r  Processing issue ${i + 1}/${allIssues.length}`)

		const comments = await getComments(issue.sourceRepo, issue.number)
		const youCommented = comments.some((c) => c.user.login === username)
		const youOpenedIt = issue.user.login === username

		issueData.push({
			title: issue.title,
			number: issue.number,
			sourceRepo: issue.sourceRepo,
			url: issue.html_url,
			author: issue.user.login,
			createdAt: issue.created_at,
			commentCount: comments.filter((c) => !BOTS.includes(c.user.login)).length,
			labels: issue.labels.map((l) => l.name),
			interacted: youCommented || youOpenedIt,
		})
	}

	console.log("\n✅ Done!\n")

	generateHTML(issueData, username)
	console.log("📄 Report saved to: issue-tracker-report.html")
}

function generateHTML(issueData, username) {
	const needsAttention = issueData.filter(
		(i) => !i.interacted && i.author !== username,
	)
	const othersOpened = issueData.filter((i) => i.author !== username)

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Issue Tracker</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f0f0; color: #333; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        nav { display: flex; gap: 8px; margin-bottom: 20px; }
        nav a { padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500; color: #24292e; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        nav a.active { background: #a21caf; color: white; }
        header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { font-size: 20px; margin-bottom: 10px; }
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-top: 15px; }
        .stat-box { padding: 15px; border-radius: 6px; text-align: center; color: white; font-weight: 500; background: #a21caf; }
        .stat-number { font-size: 32px; font-weight: bold; }
        .stat-label { font-size: 12px; opacity: 0.9; }
        .repo-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 15px; }
        .repo-filter { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; background: white; border: 2px solid transparent; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.1); color: #333; }
        .repo-filter .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .repo-filter.active { border-color: currentColor; }
        .issue-row { background: white; padding: 15px; margin-bottom: 10px; border-radius: 6px; border-left: 4px solid #a21caf; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .issue-row.hidden { display: none; }
        .issue-title { font-weight: 600; margin-bottom: 8px; }
        .issue-title a { color: #0066cc; text-decoration: none; }
        .issue-meta { font-size: 13px; color: #666; margin-bottom: 8px; }
        .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; background: #e1e4e8; }
        .repo-badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: white; margin-right: 8px; }
        .empty { text-align: center; padding: 30px; color: #999; }
        footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <nav>
            <a href="tracker-report.html">📊 PR Tracker</a>
            <a href="issue-tracker-report.html" class="active">🆕 Issue Tracker</a>
        </nav>
        <header>
            <h1>🆕 Issue Tracker</h1>
            <p style="color: #999; font-size: 12px;">Updated: ${new Date().toLocaleString()}</p>
            <div class="stats">
                <div class="stat-box">
                    <div class="stat-number">${needsAttention.length}</div>
                    <div class="stat-label">Needs Attention</div>
                </div>
                <div class="stat-box">
                    <div class="stat-number">${othersOpened.length}</div>
                    <div class="stat-label">Others Opened</div>
                </div>
                <div class="stat-box">
                    <div class="stat-number">${issueData.length}</div>
                    <div class="stat-label">Total Issues</div>
                </div>
            </div>
        </header>

        <section>
            <h2 style="font-size: 16px; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #ddd;">Issues You Haven't Interacted With</h2>
            <div class="repo-filters">
                <button type="button" class="repo-filter active" data-repo="all"><span class="dot" style="background:#a21caf;"></span>All (${needsAttention.length})</button>
                ${REPOS.map((repo) => {
									const info = getRepoInfo(repo)
									const count = needsAttention.filter(
										(i) => i.sourceRepo === repo,
									).length
									return `<button type="button" class="repo-filter" data-repo="${repo}" style="color: ${info.color};"><span class="dot" style="background:${info.color};"></span>${escapeHtml(info.label)} (${count})</button>`
								}).join("")}
            </div>
            <div id="issue-list">
            ${
							needsAttention.length > 0
								? needsAttention
										.map((issue) => generateIssueRow(issue))
										.join("")
								: '<div class="empty">All clear! 🎉</div>'
						}
            </div>
        </section>
    </div>
    <footer>Generated by Issue Tracker</footer>
    <script>
        document.querySelectorAll(".repo-filter").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".repo-filter").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                const repo = btn.dataset.repo
                document.querySelectorAll(".issue-row").forEach((row) => {
                    row.classList.toggle("hidden", repo !== "all" && row.dataset.repo !== repo)
                })
            })
        })
    </script>
</body>
</html>`

	fs.writeFileSync("issue-tracker-report.html", html)
}

function generateIssueRow(issue) {
	const repoInfo = getRepoInfo(issue.sourceRepo)
	return `<div class="issue-row" data-repo="${issue.sourceRepo}" style="border-left-color: ${repoInfo.color};">
        <div class="issue-title">
            <span class="repo-badge" style="background: ${repoInfo.color};">${escapeHtml(repoInfo.label)}</span>
            <a href="${issue.url}" target="_blank">#${issue.number}</a>
            <span style="font-weight: normal; color: #666;"> ${escapeHtml(issue.title)}</span>
        </div>
        <div class="issue-meta">
            Author: <strong>${issue.author}</strong> | Comments: ${issue.commentCount}
        </div>
        ${issue.labels.length > 0 ? `<div style="margin-top: 6px;">${issue.labels.map((l) => `<span class="badge">${escapeHtml(l)}</span>`).join(" ")}</div>` : ""}
    </div>`
}

function escapeHtml(text) {
	const map = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	}
	return text.replace(/[&<>"']/g, (m) => map[m])
}

module.exports = { main }

if (require.main === module) {
	main().catch((err) => {
		console.error("❌ Error:", err.message)
		process.exit(1)
	})
}
