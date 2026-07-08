#!/usr/bin/env node

const https = require("https")
const fs = require("fs")
const path = require("path")

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

// Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const REPOS = {
	docs: ["mautic/developer-documentation-new", "mautic/user-documentation"],
	app: "mautic/mautic",
}

const BOTS = ["dependabot", "github-actions", "renovate", "codecov", "mergify"]

// Simple HTTP request helper
function makeRequest(url) {
	return new Promise((resolve, reject) => {
		const options = {
			headers: {
				Authorization: `token ${GITHUB_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Mautic-Docs-Tracker",
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

// Get authenticated user's login from token
async function getAuthenticatedUser() {
	try {
		const user = await makeRequest("https://api.github.com/user")
		return user.login
	} catch (e) {
		console.error("Could not get authenticated user:", e.message)
		return null
	}
}

// Extract app PR info from description (supports any mautic/* repo)
function extractAppPR(description) {
	if (!description) return null

	// Match patterns like:
	// mautic/mautic PR #12345
	// mautic/api-library#12345
	// Mautic PR #16067
	// [PR #15926] format

	let match = description.match(/mautic\/([a-z0-9-]+)\s*(?:PR\s*)?#(\d+)/i)
	if (match) {
		return {
			repo: `mautic/${match[1]}`,
			number: match[2],
		}
	}

	// Fallback: if just "Mautic PR #12345" anywhere in text
	match = description.match(/mautic\s+PR\s*#(\d+)/i)
	if (match) {
		return {
			repo: "mautic/mautic",
			number: match[1],
		}
	}

	// Fallback: [PR #12345] format (assume mautic/mautic)
	match = description.match(/\[PR\s*#(\d+)\]/i)
	if (match) {
		return {
			repo: "mautic/mautic",
			number: match[1],
		}
	}

	return null
}

// Filter out bot comments/reviews
function isHumanReview(review) {
	return !BOTS.includes(review.user.login)
}

// Get reviews for a PR
async function getReviews(repo, prNumber, targetUser = null) {
	try {
		const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`
		const reviews = await makeRequest(url)

		const humanReviews = reviews.filter((r) => isHumanReview(r))
		const approvedReviews = humanReviews.filter((r) => r.state === "APPROVED")
		const approvals = approvedReviews.length
		const changesRequested = humanReviews.filter(
			(r) => r.state === "CHANGES_REQUESTED",
		).length

		// Unique logins of everyone who approved, in order
		const approvedBy = [...new Set(approvedReviews.map((r) => r.user.login))]

		// Check if specific user approved
		const userApproved = targetUser
			? humanReviews.some(
					(r) => r.user.login === targetUser && r.state === "APPROVED",
				)
			: false

		// Get latest review
		const latestReview =
			humanReviews.length > 0 ? humanReviews[humanReviews.length - 1] : null

		return {
			approvals,
			approvedBy,
			changesRequested,
			hasReview: approvals > 0 || changesRequested > 0,
			userApproved,
			latestReview,
		}
	} catch (e) {
		console.error(`Error fetching reviews for ${repo}#${prNumber}:`, e.message)
		return {
			approvals: 0,
			approvedBy: [],
			changesRequested: 0,
			hasReview: false,
			userApproved: false,
			latestReview: null,
		}
	}
}

// Get comments for a PR
async function getComments(repo, prNumber) {
	try {
		const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`
		const comments = await makeRequest(url)
		const humanComments = comments.filter((c) => !BOTS.includes(c.user.login))
		return {
			count: humanComments.length,
			latest:
				humanComments.length > 0
					? humanComments[humanComments.length - 1]
					: null,
		}
	} catch (e) {
		console.error(`Error fetching comments for ${repo}#${prNumber}:`, e.message)
		return { count: 0, latest: null }
	}
}

// Get latest approval from dev and check if dismissed by later commits
async function getApprovalStatus(repo, prNumber, devUsername) {
	if (!devUsername)
		return {
			approved: false,
			dismissedByChanges: false,
			lastApprovalDate: null,
			latestCommitDate: null,
			lastCommitAuthor: null,
		}

	try {
		const reviewUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`
		const commitsUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/commits`

		const reviews = await makeRequest(reviewUrl)
		const commits = await makeRequest(commitsUrl)

		// Find latest approval from dev
		const devApprovals = reviews.filter(
			(r) => r.user.login === devUsername && r.state === "APPROVED",
		)
		if (devApprovals.length === 0)
			return {
				approved: false,
				dismissedByChanges: false,
				lastApprovalDate: null,
				latestCommitDate: null,
				lastCommitAuthor: null,
			}

		const lastApproval = devApprovals[devApprovals.length - 1]
		const lastApprovalDate = new Date(lastApproval.submitted_at)

		// Find latest commit after approval
		const commitsAfterApproval = commits.filter(
			(c) => new Date(c.commit.author.date) > lastApprovalDate,
		)

		if (commitsAfterApproval.length === 0) {
			return {
				approved: true,
				dismissedByChanges: false,
				lastApprovalDate,
				latestCommitDate: null,
				lastCommitAuthor: null,
			}
		}

		// Get latest commit after approval
		const latestCommit = commitsAfterApproval[commitsAfterApproval.length - 1]
		const latestCommitDate = new Date(latestCommit.commit.author.date)
		const lastCommitAuthor =
			latestCommit.commit.author.name || latestCommit.author?.login || "Unknown"

		return {
			approved: true,
			dismissedByChanges: true,
			lastApprovalDate,
			latestCommitDate,
			lastCommitAuthor,
		}
	} catch (e) {
		console.error(
			`Error checking approval status for ${repo}#${prNumber}:`,
			e.message,
		)
		return {
			approved: false,
			dismissedByChanges: false,
			lastApprovalDate: null,
			latestCommitDate: null,
			lastCommitAuthor: null,
		}
	}
}

// Get last interaction on a PR (review or comment)
async function getLastInteraction(repo, prNumber) {
	try {
		const reviewUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`
		const commentUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`

		const reviews = await makeRequest(reviewUrl)
		const comments = await makeRequest(commentUrl)

		const humanReviews = reviews.filter((r) => isHumanReview(r))
		const humanComments = comments.filter((c) => !BOTS.includes(c.user.login))

		const allInteractions = []

		humanReviews.forEach((r) => {
			allInteractions.push({
				user: r.user.login,
				date: new Date(r.submitted_at),
				action: `${r.state === "APPROVED" ? "Approved" : r.state === "CHANGES_REQUESTED" ? "Requested changes" : "Reviewed"}`,
			})
		})

		humanComments.forEach((c) => {
			allInteractions.push({
				user: c.user.login,
				date: new Date(c.created_at),
				action: "Commented",
			})
		})

		if (allInteractions.length === 0) return null

		// Sort by date and get latest
		return allInteractions.sort((a, b) => b.date - a.date)[0]
	} catch (e) {
		console.error(
			`Error fetching interactions for ${repo}#${prNumber}:`,
			e.message,
		)
		return null
	}
}

// Check if maintainer commented or was mentioned on app PR, and get their latest activity
async function getMaintainerActivityOnAppPR(
	repo,
	prNumber,
	maintainerUsername,
) {
	if (!maintainerUsername) return null

	try {
		const reviewUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`
		const commentUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`

		const reviews = await makeRequest(reviewUrl)
		const comments = await makeRequest(commentUrl)

		const allActivity = []

		// Find maintainer's reviews
		reviews.forEach((r) => {
			if (r.user.login === maintainerUsername) {
				allActivity.push({
					type: "review",
					date: new Date(r.submitted_at),
					user: r.user.login,
					state: r.state,
				})
			}
		})

		// Find maintainer's comments or mentions
		comments.forEach((c) => {
			if (c.user.login === maintainerUsername) {
				allActivity.push({
					type: "comment",
					date: new Date(c.created_at),
					user: c.user.login,
					content: c.body,
				})
			} else if (c.body.includes(`@${maintainerUsername}`)) {
				// Someone mentioned the maintainer
				allActivity.push({
					type: "mention",
					date: new Date(c.created_at),
					user: c.user.login,
					content: c.body,
				})
			}
		})

		if (allActivity.length === 0) return null

		// Get latest activity
		const latest = allActivity.sort((a, b) => b.date - a.date)[0]
		return latest
	} catch (e) {
		console.error(
			`Error checking maintainer activity on ${repo}#${prNumber}:`,
			e.message,
		)
		return null
	}
}

// Check if dev responded after maintainer's activity
async function didDevRespondAfter(repo, prNumber, devUsername, afterDate) {
	if (!devUsername || !afterDate) return false

	try {
		const reviewUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`
		const commentUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`

		const reviews = await makeRequest(reviewUrl)
		const comments = await makeRequest(commentUrl)

		// Check if dev commented after the maintainer's activity
		const devComments = comments.filter(
			(c) => c.user.login === devUsername && new Date(c.created_at) > afterDate,
		)
		const devReviews = reviews.filter(
			(r) =>
				r.user.login === devUsername && new Date(r.submitted_at) > afterDate,
		)

		return devComments.length > 0 || devReviews.length > 0
	} catch (e) {
		console.error(
			`Error checking dev response on ${repo}#${prNumber}:`,
			e.message,
		)
		return false
	}
}
async function getOpenPRs(repo) {
	try {
		const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`
		const prs = await makeRequest(url)
		return prs
	} catch (e) {
		console.error(`Error fetching PRs from ${repo}:`, e.message)
		return []
	}
}

// Main process
async function main() {
	if (!GITHUB_TOKEN) {
		console.error("❌ GITHUB_TOKEN environment variable not set")
		console.error('Set it with: export GITHUB_TOKEN="your_token_here"')
		process.exit(1)
	}

	// Get maintainer username
	console.log("🔍 Getting your GitHub username...")
	const maintainerUsername = await getAuthenticatedUser()
	if (!maintainerUsername) {
		console.error("❌ Could not get GitHub username from token")
		process.exit(1)
	}
	console.log(`✅ Tracked as: ${maintainerUsername}\n`)

	console.log("📊 Fetching open docs PRs...")
	const allPRs = []

	// Get PRs from both docs repos
	for (const repo of REPOS.docs) {
		console.log(`  Scanning ${repo}...`)
		const prs = await getOpenPRs(repo)
		allPRs.push(...prs.map((pr) => ({ ...pr, sourceRepo: repo })))
	}

	console.log(`Found ${allPRs.length} open docs PRs\n`)

	// Process each PR
	const prData = []
	for (let i = 0; i < allPRs.length; i++) {
		const pr = allPRs[i]
		process.stdout.write(`\r  Processing PR ${i + 1}/${allPRs.length}`)

		const appPRData = extractAppPR(pr.body)
		let appMerged = false
		let appPRStatus = "Not linked"
		let appPRAuthor = null
		let appPRNumber = null
		let appPRRepo = null
		let appPRUrl = null

		if (appPRData) {
			appPRNumber = appPRData.number
			appPRRepo = appPRData.repo
			appPRUrl = `https://github.com/${appPRRepo}/pull/${appPRNumber}`

			try {
				const appPRFetch = await makeRequest(
					`https://api.github.com/repos/${appPRRepo}/pulls/${appPRNumber}`,
				)
				appMerged = appPRFetch.merged
				appPRStatus = appMerged ? "Merged ✅" : "Open"
				appPRAuthor = appPRFetch.user.login
			} catch (e) {
				console.error(`Error fetching ${appPRRepo}#${appPRNumber}:`, e.message)
				appPRStatus = "Error fetching"
			}
		}

		const reviews = await getReviews(pr.sourceRepo, pr.number, appPRAuthor)
		const comments = await getComments(pr.sourceRepo, pr.number)
		const lastInteraction = await getLastInteraction(pr.sourceRepo, pr.number)

		// Get detailed approval status (checks if dismissed by changes)
		const approvalStatus = await getApprovalStatus(
			pr.sourceRepo,
			pr.number,
			appPRAuthor,
		)

		// Get variables needed for categorization
		const devApproved = approvalStatus.approved
		const hasPendingLabel = pr.labels.some((l) => l.name === "pending-pr-merge")

		// Determine category - SIMPLE 3 GROUPS ONLY
		let category = ""

		// Check response time on docs PR and code PR
		const docsHasResponse = devApproved || comments.count > 0
		const daysSinceDocsCreated = Math.floor(
			(new Date() - new Date(pr.created_at)) / (1000 * 60 * 60 * 24),
		)

		let codeHasResponse = false
		if (appPRAuthor) {
			codeHasResponse = await didDevRespondAfter(
				appPRRepo,
				appPRNumber,
				appPRAuthor,
				new Date(0),
			) // Check if any response ever
		}

		// RED: Do NOW
		if (appMerged && hasPendingLabel) {
			category = "do-now-remove-label"
		} else if (
			appMerged &&
			daysSinceDocsCreated >= 14 &&
			!docsHasResponse &&
			!codeHasResponse
		) {
			category = "do-now-ask-core-team"
		} else if (
			appMerged &&
			daysSinceDocsCreated >= 7 &&
			!docsHasResponse &&
			!codeHasResponse
		) {
			category = "do-now-remind-dev"
		}
		// GREEN: Waiting for code PR
		else if (appPRNumber && !appMerged) {
			category = "waiting-code-pr"
		}
		// GRAY: Monitoring
		else {
			category = "monitoring"
		}

		prData.push({
			title: pr.title,
			number: pr.number,
			sourceRepo: pr.sourceRepo,
			url: pr.html_url,
			appPRNumber: appPRNumber,
			appPRRepo: appPRRepo,
			appPRStatus,
			appPRUrl: appPRUrl,
			appMerged,
			appPRAuthor,
			reviewCount: reviews.approvals,
			approvedBy: reviews.approvedBy,
			lastActor: lastInteraction,
			commentCount: comments.count,
			devApproved,
			approvalDismissed: approvalStatus.dismissedByChanges,
			lastCommitAuthor: approvalStatus.lastCommitAuthor,
			lastCommitDate: approvalStatus.latestCommitDate,
			category,
			daysSinceDocs: daysSinceDocsCreated,
			hasResponse: docsHasResponse || codeHasResponse,
			labels: pr.labels.map((l) => l.name),
			createdAt: pr.created_at,
			author: pr.user.login,
		})
	}

	console.log(`\n✅ Done!\n`)

	// Generate HTML
	generateHTML(prData)
	console.log("📄 Report saved to: tracker-report.html")
	console.log("Open it in your browser to view the dashboard\n")
}

function generateHTML(prData) {
	const doNow = prData.filter((p) => p.category.startsWith("do-now-"))
	const waiting = prData.filter((p) => p.category === "waiting-code-pr")
	const monitoring = prData.filter((p) => p.category === "monitoring")

	const html =
		`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Docs PR Tracker</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f0f0; color: #333; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        
        header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { font-size: 20px; margin-bottom: 10px; }
        .time { color: #999; font-size: 12px; }
        
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-top: 15px; }
        .stat-box { padding: 15px; border-radius: 6px; text-align: center; color: white; font-weight: 500; }
        .stat-box.red { background: #d32f2f; }
        .stat-box.green { background: #388e3c; }
        .stat-box.gray { background: #666; }
        .stat-number { font-size: 32px; font-weight: bold; margin-bottom: 5px; }
        .stat-label { font-size: 12px; opacity: 0.9; }
        
        section { margin-bottom: 30px; }
        section h2 { font-size: 16px; margin-bottom: 15px; padding: 10px 15px; border-radius: 4px; color: white; font-weight: 600; }
        section.red h2 { background: #d32f2f; }
        section.green h2 { background: #388e3c; }
        section.gray h2 { background: #666; }
        
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; font-size: 13px; border-bottom: 2px solid #ddd; }
        td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
        tr:hover { background: #f9f9f9; }
        
        tr.red-row { background: #fff5f5; }
        tr.red-row:hover { background: #ffebee; }
        tr.green-row { background: #f5fff5; }
        tr.green-row:hover { background: #ebf5eb; }
        tr.gray-row { background: #fafafa; }
        tr.gray-row:hover { background: #f0f0f0; }
        
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
        
        .badge { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 11px; font-weight: 500; color: white; white-space: nowrap; }
        .badge.merged { background: #6f42c1; }
        .badge.open { background: #388e3c; }
        .badge.approved { background: #388e3c; }
        .badge.not-approved { background: #d32f2f; }
        
        .action { color: #d32f2f; font-weight: 500; }
        .empty { text-align: center; padding: 40px; color: #999; background: white; border-radius: 8px; }
        footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📊 Docs PR Tracker</h1>
            <p class="time">Updated: ${new Date().toLocaleString()}</p>
            <div class="stats">
                <div class="stat-box red"><div class="stat-number">${doNow.length}</div><div class="stat-label">🚨 DO NOW</div></div>
                <div class="stat-box green"><div class="stat-number">${waiting.length}</div><div class="stat-label">⏳ WAITING</div></div>
                <div class="stat-box gray"><div class="stat-number">${monitoring.length}</div><div class="stat-label">📋 MONITORING</div></div>
            </div>
        </header>
        
        ` +
		(doNow.length > 0
			? `
        <section class="red">
            <h2>🚨 DO NOW (${doNow.length})</h2>
            <table>
                <thead><tr><th>PR</th><th>Code PR</th><th>Code PR Author</th><th>Approved</th><th>Approved By</th><th>Last Actor (Docs PR)</th><th>Action</th></tr></thead>
                <tbody>${doNow.map((pr) => generateRow(pr, "red-row")).join("")}</tbody>
            </table>
        </section>
        `
			: "") +
		`
        
        ` +
		(waiting.length > 0
			? `
        <section class="green">
            <h2>⏳ WAITING (${waiting.length})</h2>
            <table>
                <thead><tr><th>PR</th><th>Code PR</th><th>Code PR Author</th><th>Approved</th><th>Approved By</th><th>Last Actor (Docs PR)</th><th>Status</th></tr></thead>
                <tbody>${waiting.map((pr) => generateRow(pr, "green-row")).join("")}</tbody>
            </table>
        </section>
        `
			: "") +
		`
        
        ` +
		(monitoring.length > 0
			? `
        <section class="gray">
            <h2>📋 MONITORING (${monitoring.length})</h2>
            <table>
                <thead><tr><th>PR</th><th>Code PR</th><th>Code PR Author</th><th>Approved</th><th>Approved By</th><th>Last Actor (Docs PR)</th><th>Status</th></tr></thead>
                <tbody>${monitoring.map((pr) => generateRow(pr, "gray-row")).join("")}</tbody>
            </table>
        </section>
        `
			: "") +
		`
        
        ${doNow.length === 0 && waiting.length === 0 && monitoring.length === 0 ? '<div class="empty">No PRs</div>' : ""}
    </div>
    <footer>Run: node tracker.js • Updated: ${new Date().toLocaleTimeString()}</footer>
</body>
</html>`

	fs.writeFileSync("tracker-report.html", html)
}

function generateRow(pr, rowClass = "") {
	let action = ""
	if (pr.category.includes("remove-label"))
		action = '<span class="action">Remove label</span>'
	else if (pr.category.includes("ask-core-team"))
		action = '<span class="action">Ask core team</span>'
	else if (pr.category.includes("remind-dev"))
		action =
			'<span class="action">Remind dev (' + pr.daysSinceDocs + "d)</span>"

	const approved = pr.devApproved
		? pr.approvalDismissed
			? '<span class="badge approved">✅ (dismissed)</span>'
			: '<span class="badge approved">✅</span>'
		: '<span class="badge not-approved">❌</span>'

	const codePRAuthor = pr.appPRAuthor ? escapeHtml(pr.appPRAuthor) : "—"

	const approvedBy =
		pr.approvedBy && pr.approvedBy.length > 0
			? escapeHtml(pr.approvedBy.join(", "))
			: "—"

	const lastActor = pr.lastActor
		? escapeHtml(pr.lastActor.user) + " (" + escapeHtml(pr.lastActor.action) + ")"
		: "—"

	return (
		'<tr class="' +
		rowClass +
		'">' +
		'<td><a href="' +
		pr.url +
		'" target="_blank">' +
		pr.sourceRepo.split("/")[1].replace("-new", "") +
		" #" +
		pr.number +
		"</a></td>" +
		"<td>" +
		(pr.appPRNumber
			? '<a href="' +
				pr.appPRUrl +
				'" target="_blank">#' +
				pr.appPRNumber +
				'</a> <span class="badge ' +
				(pr.appMerged ? "merged" : "open") +
				'">' +
				(pr.appMerged ? "Merged" : "Open") +
				"</span>"
			: "Not linked") +
		"</td>" +
		"<td>" +
		codePRAuthor +
		"</td>" +
		"<td>" +
		approved +
		"</td>" +
		"<td>" +
		approvedBy +
		"</td>" +
		"<td>" +
		lastActor +
		"</td>" +
		"<td>" +
		action +
		"</td>" +
		"</tr>"
	)
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
