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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const REPOS = {
	docs: ["mautic/developer-documentation-new", "mautic/user-documentation"],
}

const BOTS = [
	"dependabot",
	"github-actions",
	"renovate",
	"codecov",
	"mergify",
	"promptless-for-oss", // AI suggestion bot that opens & comments on docs PRs
]

const PENDING_LABEL = process.env.PENDING_LABEL || "pending-pr-merge"
const BACKPORT_LABEL = process.env.BACKPORT_LABEL || "needs-backport"
const RELEASE_BRANCH_PATTERN = /^\d+\.\d+$/
const FOLLOWUP_DAYS = 7
const ESCALATE_DAYS = 14

// Optional comma-separated list of additional maintainer logins who all
// count as "the operator" (team mode). The authenticated user always counts.
const CONFIGURED_OPERATOR_LOGINS = (process.env.OPERATOR_LOGINS || "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean)

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

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

async function getAuthenticatedUser() {
	try {
		const user = await makeRequest("https://api.github.com/user")
		return user.login
	} catch (e) {
		console.error("Could not get authenticated user:", e.message)
		return null
	}
}

async function getOpenPRs(repo) {
	try {
		const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`
		return await makeRequest(url)
	} catch (e) {
		console.error(`Error fetching PRs from ${repo}:`, e.message)
		return []
	}
}

function isHuman(login) {
	return !BOTS.includes(login)
}

// Both fetchers return the *raw* list (bots included). Callers filter with
// isHuman() for the participant logic; the community-thread detector needs the
// unfiltered list so it can spot the promptless bot pinging a human reviewer.
async function fetchPRReviews(repo, number) {
	try {
		return await makeRequest(
			`https://api.github.com/repos/${repo}/pulls/${number}/reviews`,
		)
	} catch (e) {
		console.error(`Error fetching reviews for ${repo}#${number}:`, e.message)
		return []
	}
}

async function fetchIssueComments(repo, number) {
	try {
		return await makeRequest(
			`https://api.github.com/repos/${repo}/issues/${number}/comments`,
		)
	} catch (e) {
		console.error(`Error fetching comments for ${repo}#${number}:`, e.message)
		return []
	}
}

async function fetchCodePR(repo, number) {
	try {
		const pr = await makeRequest(
			`https://api.github.com/repos/${repo}/pulls/${number}`,
		)
		return {
			merged: pr.merged,
			mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
			state: pr.state,
			author: pr.user.login,
		}
	} catch (e) {
		console.error(`Error fetching code PR ${repo}#${number}:`, e.message)
		return { merged: false, mergedAt: null, state: "open", author: null }
	}
}

// Latest version-pattern branch per repo, fetched once and cached.
const branchCache = new Map()

function compareVersions(a, b) {
	const pa = a.split(".").map(Number)
	const pb = b.split(".").map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] || 0
		const db = pb[i] || 0
		if (da !== db) return da - db
	}
	return 0
}

async function getLatestReleaseBranch(repo) {
	if (branchCache.has(repo)) return branchCache.get(repo)
	let latest = null
	try {
		const branches = await makeRequest(
			`https://api.github.com/repos/${repo}/branches?per_page=100`,
		)
		const versioned = branches
			.map((b) => b.name)
			.filter((name) => RELEASE_BRANCH_PATTERN.test(name))
		if (versioned.length > 0) {
			latest = versioned.reduce((max, name) =>
				compareVersions(name, max) > 0 ? name : max,
			)
		}
	} catch (e) {
		console.error(`Error fetching branches for ${repo}:`, e.message)
	}
	branchCache.set(repo, latest)
	return latest
}

function targetsOlderBranch(baseBranch, latestReleaseBranch) {
	if (!latestReleaseBranch) return false
	if (!RELEASE_BRANCH_PATTERN.test(baseBranch)) return false
	return compareVersions(baseBranch, latestReleaseBranch) < 0
}

// Extract app PR info from description (supports any mautic/* repo)
function extractAppPR(description) {
	if (!description) return null

	let match = description.match(/mautic\/([a-z0-9-]+)\s*(?:PR\s*)?#(\d+)/i)
	if (match) {
		return { repo: `mautic/${match[1]}`, number: match[2] }
	}

	match = description.match(/mautic\s+PR\s*#(\d+)/i)
	if (match) {
		return { repo: "mautic/mautic", number: match[1] }
	}

	match = description.match(/\[PR\s*#(\d+)\]/i)
	if (match) {
		return { repo: "mautic/mautic", number: match[1] }
	}

	return null
}

// ---------------------------------------------------------------------------
// Data model derivations (docs/data-model.md)
// ---------------------------------------------------------------------------

function maxDate(a, b) {
	if (!a || !b) return null
	return a > b ? a : b
}

function earliestDate(dates) {
	if (dates.length === 0) return null
	return new Date(Math.min(...dates.map((d) => d.getTime())))
}

function latestDate(dates) {
	if (dates.length === 0) return null
	return new Date(Math.max(...dates.map((d) => d.getTime())))
}

function escapeRegExp(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// True when `body` @-mentions `login` (word-boundaried, case-insensitive).
// Strip fenced/inline code spans so quoted code — an email like
// `name@example.com`, an `@decorator`, etc. — never reads as a mention;
// GitHub itself doesn't linkify @-text inside code spans either.
function stripCodeSpans(body) {
	return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "")
}

function mentions(body, login) {
	if (!body || !login) return false
	// Negative lookbehind excludes "@" glued to a preceding word character —
	// the email false-positive (name@example.com) is exactly this shape.
	return new RegExp(`(?<![a-zA-Z0-9_])@${escapeRegExp(login)}\\b`, "i").test(
		stripCodeSpans(body),
	)
}

// Extract every @-mention login from a comment body, lowercased, in order.
function extractMentions(body) {
	if (!body) return []
	const found = []
	const re = /(?<![a-zA-Z0-9_])@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})/gi
	let m
	while ((m = re.exec(stripCodeSpans(body))) !== null) found.push(m[1].toLowerCase())
	return found
}

// §4 — operator's own docs-PR review done
function computeOperatorReviewDate(docsReviews, docsComments, operatorLogins) {
	const reviewDates = docsReviews
		.filter(
			(r) =>
				operatorLogins.has(r.user.login.toLowerCase()) &&
				["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(r.state),
		)
		.map((r) => new Date(r.submitted_at))
	const commentDates = docsComments
		.filter((c) => operatorLogins.has(c.user.login.toLowerCase()))
		.map((c) => new Date(c.created_at))
	return earliestDate([...reviewDates, ...commentDates])
}

// The reminder/response conversation. A "ping" is any comment — by an
// operator OR anyone else who isn't the code author — that @-tags the code
// PR author. Whoever tags the author is effectively reminding them, so any
// such tag starts the remind/follow-up/escalate clock (this is what lets a
// teammate's reminder, not just yours, drive escalation). The @-tag is an
// unambiguous signal, so no date anchor is needed — an old, never-answered
// tag is still an outstanding reminder.
//
// A plain operator comment (no tag) is just a reply: it moves the PR into
// "monitoring" with its own, separate staleness clock (see the category
// logic in main()), rather than resetting the ping clock.
function computeConversationState({
	docsComments,
	docsReviews,
	codeComments,
	codeReviews,
	operatorLogins,
	appPRAuthor,
}) {
	const allComments = [...docsComments, ...codeComments]
	const allReviews = [...docsReviews, ...codeReviews]

	const pings = appPRAuthor
		? allComments.filter(
				(c) => c.user.login !== appPRAuthor && mentions(c.body, appPRAuthor),
			)
		: []
	const lastPing = pings.reduce(
		(best, c) =>
			!best || new Date(c.created_at) > new Date(best.created_at) ? c : best,
		null,
	)
	const lastPingDate = lastPing ? new Date(lastPing.created_at) : null
	const lastPingActor = lastPing ? lastPing.user.login : null
	const lastPingByOperator = lastPing
		? operatorLogins.has(lastPingActor.toLowerCase())
		: false

	const lastOperatorTouchDate = latestDate([
		...allComments
			.filter((c) => operatorLogins.has(c.user.login.toLowerCase()))
			.map((c) => new Date(c.created_at)),
		...allReviews
			.filter((r) => operatorLogins.has(r.user.login.toLowerCase()))
			.map((r) => new Date(r.submitted_at)),
	])

	const lastAuthorEventDate = appPRAuthor
		? latestDate([
				...allComments
					.filter((c) => c.user.login === appPRAuthor)
					.map((c) => new Date(c.created_at)),
				...allReviews
					.filter((r) => r.user.login === appPRAuthor)
					.map((r) => new Date(r.submitted_at)),
			])
		: null

	return {
		lastPingDate,
		lastPingActor,
		lastPingByOperator,
		lastOperatorTouchDate,
		lastAuthorEventDate,
	}
}

// Bots other than promptless-for-oss are always noise. Promptless is the AI
// that drafts these docs PRs and tags a human reviewer when it's addressed
// their feedback — that tag is a genuine "your turn" signal worth surfacing,
// so it's treated as a commenter rather than filtered out.
const IGNORED_BOTS = BOTS.filter((b) => b !== "promptless-for-oss")
const PROMPTLESS = "promptless-for-oss"

// A live thread on the *docs* PR (never the code PR) that isn't the
// operator's own author-reminder (those are pings, handled above). Answers
// "who is waiting on whom" from the most recent qualifying docs-PR comment
// that nobody has answered. Author-targeted tags are deliberately excluded
// here — they're pings and drive the escalation clock instead. What's left:
// someone waiting on you, on a third party (including promptless chasing a
// reviewer), or an untagged comment you must triage.
function computeCommunityThread({ rawDocsComments, rawDocsReviews, operatorLogins, appPRAuthor }) {
	const none = { lit: false }
	const comments = rawDocsComments.filter((c) => !IGNORED_BOTS.includes(c.user.login))
	if (comments.length === 0) return none

	const last = comments.reduce((best, c) =>
		new Date(c.created_at) > new Date(best.created_at) ? c : best,
	)
	const commenter = last.user.login
	const lastDate = new Date(last.created_at)
	const commenterIsPromptless = commenter === PROMPTLESS

	// The docs PR author working on their own PR isn't "someone waiting."
	if (!commenterIsPromptless && appPRAuthor && commenter === appPRAuthor) return none

	// Answered already? Any later qualifying comment/review by someone else.
	const reviews = rawDocsReviews.filter((r) => !IGNORED_BOTS.includes(r.user.login))
	const answered = [...comments, ...reviews].some((e) => {
		const who = e.user.login
		const when = new Date(e.submitted_at || e.created_at)
		return who !== commenter && when > lastDate
	})
	if (answered) return none

	// Ignore self-mentions and any @-mention of a known bot — neither is a
	// real "waiting on someone" signal.
	const tagged = extractMentions(last.body).filter(
		(t) => t !== commenter.toLowerCase() && !BOTS.includes(t),
	)
	const commenterIsOperator = operatorLogins.has(commenter.toLowerCase())

	if (commenterIsPromptless) {
		// Only worth surfacing if promptless tagged a real reviewer outside
		// the operator/team — that's "go check what they asked for changes
		// on, promptless just addressed it." A tag of you/your team (you'll
		// see it yourself) or no tag at all is not worth a row.
		const nonOperatorTagged = tagged.filter((t) => !operatorLogins.has(t))
		if (nonOperatorTagged.length === 0) return none
		return {
			lit: true,
			commenter,
			commenterIsOperator: false,
			waitingOn: nonOperatorTagged[0],
			waitingOnKind: "third-party",
			date: lastDate,
		}
	}

	// A tag of the code author is a reminder ping. If an operator sent it,
	// the escalation clock owns it — nothing to add here. If someone else did
	// (a teammate contributor chasing the author), surface it for visibility:
	// the clock only activates after *you've* reviewed, so until then this is
	// the only thing that shows the author is being waited on.
	if (appPRAuthor && tagged.includes(appPRAuthor.toLowerCase())) {
		if (commenterIsOperator) return none
		return {
			lit: true,
			commenter,
			commenterIsOperator,
			waitingOn: appPRAuthor,
			waitingOnKind: "author",
			date: lastDate,
		}
	}

	const operatorTagged = tagged.find((t) => operatorLogins.has(t))
	if (operatorTagged) {
		// Someone is explicitly waiting on you (or a teammate operator).
		return {
			lit: true,
			commenter,
			commenterIsOperator,
			waitingOn: operatorTagged,
			waitingOnKind: "operator",
			date: lastDate,
		}
	}
	if (tagged.length > 0) {
		return {
			lit: true,
			commenter,
			commenterIsOperator,
			waitingOn: tagged[0],
			waitingOnKind: "third-party",
			date: lastDate,
		}
	}
	// Untagged comment. If the operator left it themselves with no tag, it's
	// their own note / monitoring — not "someone waiting on a reply."
	if (commenterIsOperator) return none
	return {
		lit: true,
		commenter,
		commenterIsOperator,
		waitingOn: null,
		waitingOnKind: "untagged",
		date: lastDate,
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	if (!GITHUB_TOKEN) {
		console.error("❌ GITHUB_TOKEN environment variable not set")
		console.error('Set it with: export GITHUB_TOKEN="your_token_here"')
		process.exit(1)
	}

	console.log("🔍 Getting your GitHub username...")
	const authenticatedUser = await getAuthenticatedUser()
	if (!authenticatedUser) {
		console.error("❌ Could not get GitHub username from token")
		process.exit(1)
	}
	console.log(`✅ Tracked as: ${authenticatedUser}\n`)

	const operatorLogins = new Set(
		[authenticatedUser.toLowerCase(), ...CONFIGURED_OPERATOR_LOGINS],
	)

	console.log("📊 Fetching open docs PRs...")
	const allPRs = []
	for (const repo of REPOS.docs) {
		console.log(`  Scanning ${repo}...`)
		const prs = await getOpenPRs(repo)
		allPRs.push(...prs.map((pr) => ({ ...pr, sourceRepo: repo })))
	}
	console.log(`Found ${allPRs.length} open docs PRs\n`)

	const prData = []
	for (let i = 0; i < allPRs.length; i++) {
		const pr = allPRs[i]
		process.stdout.write(`\r  Processing PR ${i + 1}/${allPRs.length}`)

		const isDraft = pr.draft
		const hasLabel = pr.labels.some((l) => l.name === PENDING_LABEL)
		const hasBackportLabel = pr.labels.some((l) => l.name === BACKPORT_LABEL)
		const hasMilestone = pr.milestone != null
		const milestoneTitle = pr.milestone ? pr.milestone.title : null
		const baseBranch = pr.base.ref
		const latestReleaseBranch = await getLatestReleaseBranch(pr.sourceRepo)
		const olderBranch = targetsOlderBranch(baseBranch, latestReleaseBranch)

		const appPRData = extractAppPR(pr.body)
		let appPRRepo = null
		let appPRNumber = null
		let appPRUrl = null
		let appPRAuthor = null
		let codeMerged = false
		let codeMergedDate = null
		let codeClosed = false

		if (appPRData) {
			appPRRepo = appPRData.repo
			appPRNumber = appPRData.number
			appPRUrl = `https://github.com/${appPRRepo}/pull/${appPRNumber}`
			const codePR = await fetchCodePR(appPRRepo, appPRNumber)
			codeMerged = codePR.merged
			codeMergedDate = codePR.mergedAt
			codeClosed = codePR.state === "closed" && !codePR.merged
			appPRAuthor = codePR.author
		}

		// Raw lists keep the bots (needed by the community detector); the human
		// lists drive all the participant logic (reviews, pings, responses).
		const rawDocsReviews = await fetchPRReviews(pr.sourceRepo, pr.number)
		const rawDocsComments = await fetchIssueComments(pr.sourceRepo, pr.number)
		const docsReviews = rawDocsReviews.filter((r) => isHuman(r.user.login))
		const docsComments = rawDocsComments.filter((c) => isHuman(c.user.login))
		let codeComments = []
		let codeReviews = []
		if (appPRNumber) {
			codeComments = (await fetchIssueComments(appPRRepo, appPRNumber)).filter((c) =>
				isHuman(c.user.login),
			)
			codeReviews = (await fetchPRReviews(appPRRepo, appPRNumber)).filter((r) =>
				isHuman(r.user.login),
			)
		}

		const operatorReviewDate = computeOperatorReviewDate(
			docsReviews,
			docsComments,
			operatorLogins,
		)
		const operatorReviewDone = operatorReviewDate !== null

		const devApproved = appPRAuthor
			? docsReviews.some(
					(r) => r.user.login === appPRAuthor && r.state === "APPROVED",
				)
			: false
		const nonOperatorApprovals = docsReviews.filter(
			(r) =>
				r.state === "APPROVED" && !operatorLogins.has(r.user.login.toLowerCase()),
		)
		const approvedByNonOperator = nonOperatorApprovals.length > 0
		// Unique approver logins in order — shown as a fact in any band.
		const approverLogins = [...new Set(nonOperatorApprovals.map((r) => r.user.login))]

		const {
			lastPingDate,
			lastPingActor,
			lastPingByOperator,
			lastOperatorTouchDate,
			lastAuthorEventDate,
		} = computeConversationState({
			docsComments,
			docsReviews,
			codeComments,
			codeReviews,
			operatorLogins,
			appPRAuthor,
		})
		const pingEverSent = lastPingDate !== null
		const daysSincePing = lastPingDate
			? Math.floor((Date.now() - lastPingDate.getTime()) / 86400000)
			: null
		const daysSinceOperatorTouch = lastOperatorTouchDate
			? Math.floor((Date.now() - lastOperatorTouchDate.getTime()) / 86400000)
			: null

		const community = computeCommunityThread({
			rawDocsComments,
			rawDocsReviews,
			operatorLogins,
			appPRAuthor,
		})

		// Reminded the code author, but the code PR is still open — no clock
		// starts (that waits for the merge), it's just worth showing you've
		// already nudged them so you don't do it twice.
		const remindedWhileOpen =
			pingEverSent && appPRNumber && !codeMerged && !codeClosed

		// §5a — independent action flags.
		//
		// The final-review action ("do the review, then merge") is only
		// offered once the code PR has merged (or when there's no linked code
		// PR) — while the code PR is still open we don't merge the docs PR, so
		// a non-operator approval is surfaced as a *fact* (approved by X) on a
		// waiting row rather than as a merge action.
		let removeLabelFlag = codeMerged && hasLabel
		let finalReviewActionable = approvedByNonOperator && (codeMerged || !appPRNumber)
		let backportLabelFlag = olderBranch && !hasBackportLabel
		if (codeClosed) {
			removeLabelFlag = false
			finalReviewActionable = false
			backportLabelFlag = false
		}
		const backportModifierActive = finalReviewActionable && olderBranch

		// §5b — primary lifecycle category, first match wins.
		//
		// Triage (label/milestone) is checked before "needs review" so a
		// partially-triaged draft (e.g. milestone set but label missing)
		// still surfaces the missing piece instead of jumping straight to
		// "review this docs PR".
		let category
		if (codeClosed) {
			category = "needs-close-docs-pr"
		} else if (operatorReviewDone && !appPRNumber) {
			category = "blocked-no-code-pr"
		} else if (isDraft && (!hasLabel || !hasMilestone)) {
			category = "needs-label-and-milestone"
		} else if (!isDraft && !hasMilestone) {
			category = "needs-milestone"
		} else if (hasMilestone && !operatorReviewDone) {
			category = "needs-operator-review"
		} else if (operatorReviewDone && appPRNumber && !codeMerged) {
			// Code PR still open — don't start any clock, just wait.
			category = "waiting-code-pr-merge"
		} else if (operatorReviewDone && appPRNumber && codeMerged) {
			if (!pingEverSent) {
				// Reviewed, code merged, but the author has never been
				// explicitly @-tagged yet.
				category = "needs-remind-code-author"
			} else if (lastAuthorEventDate && lastAuthorEventDate > lastPingDate) {
				// Author replied since the last ping.
				if (lastOperatorTouchDate && lastOperatorTouchDate > lastAuthorEventDate) {
					// An operator already replied after the author — normal
					// back-and-forth. If it's gone quiet for a week, resurface
					// as a prompt to send another reminder.
					category =
						daysSinceOperatorTouch >= FOLLOWUP_DAYS
							? "needs-remind-code-author"
							: "monitoring"
				} else {
					// Author replied, no operator has looked yet.
					category = "needs-check-author-response"
				}
			} else {
				// A ping is outstanding, no author reply since — run the
				// remind/follow-up/escalate clock off the latest ping.
				if (daysSincePing >= ESCALATE_DAYS) category = "needs-escalate-core-team"
				else if (daysSincePing >= FOLLOWUP_DAYS) category = "needs-followup"
				else category = "waiting-code-author-response"
			}
		} else {
			category = "monitoring"
		}

		prData.push({
			title: pr.title,
			number: pr.number,
			sourceRepo: pr.sourceRepo,
			repoShort: pr.sourceRepo.split("/")[1].replace("-new", ""),
			url: pr.html_url,
			createdAt: pr.created_at,
			isDraft,
			hasLabel,
			hasBackportLabel,
			hasMilestone,
			milestoneTitle,
			baseBranch,
			latestReleaseBranch,
			targetsOlderBranch: olderBranch,
			appPRRepo,
			appPRNumber,
			appPRUrl,
			appPRAuthor,
			codeMerged,
			codeMergedDate,
			codeClosed,
			operatorReviewDate,
			operatorReviewDone,
			devApproved,
			approvedByNonOperator,
			approverLogins,
			pingEverSent,
			lastPingDate,
			lastPingActor,
			lastPingByOperator,
			daysSincePing,
			lastOperatorTouchDate,
			daysSinceOperatorTouch,
			lastAuthorEventDate,
			community,
			remindedWhileOpen,
			removeLabelFlag,
			finalReviewActionable,
			backportLabelFlag,
			backportModifierActive,
			category,
		})
	}

	console.log(`\n✅ Done!\n`)

	generateHTML(prData, { operatorUsername: authenticatedUser })
	console.log("📄 Report saved to: tracker-report.html")
	console.log("Open it in your browser to view the dashboard\n")
}

// ---------------------------------------------------------------------------
// Rendering (docs/dashboard-redesign.md, mockups/dashboard-redesign.html)
// ---------------------------------------------------------------------------

const ACTIONABLE_CATEGORIES = new Set([
	"needs-close-docs-pr",
	"blocked-no-code-pr",
	"needs-escalate-core-team",
	"needs-followup",
	"needs-remind-code-author",
	"needs-check-author-response",
	"needs-operator-review",
	"needs-label-and-milestone",
	"needs-milestone",
])

// A community thread waiting on the code *author* is visibility-only and
// doesn't itself pull a row into Need-today (the primary category decides
// where it sits); every other community thread — waiting on you, a third
// party, or untagged — does.
function communityForcesToday(pr) {
	return pr.community.lit && pr.community.waitingOnKind !== "author"
}

function isNeedTodayRow(pr) {
	return (
		ACTIONABLE_CATEGORIES.has(pr.category) ||
		pr.finalReviewActionable ||
		pr.removeLabelFlag ||
		pr.backportLabelFlag ||
		communityForcesToday(pr)
	)
}

function escapeHtml(text) {
	if (text == null) return ""
	const map = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	}
	return String(text).replace(/[&<>"']/g, (m) => map[m])
}

function daysAgoText(date) {
	if (!date) return "recently"
	const days = Math.floor((Date.now() - date.getTime()) / 86400000)
	if (days <= 0) return "today"
	if (days === 1) return "yesterday"
	return `${days} days ago`
}

const SEV_RANK = { critical: 5, dismiss: 4, serious: 3, act: 2, triage: 1, none: 0 }

// Severity from the primary category alone.
function categorySeverity(pr) {
	switch (pr.category) {
		case "needs-close-docs-pr":
			return "dismiss"
		case "needs-escalate-core-team":
			return "critical"
		case "needs-followup":
			return "serious"
		case "needs-remind-code-author":
		case "needs-check-author-response":
			return "act"
		case "needs-operator-review":
			// Optional while the code PR is open (triage housekeeping);
			// mandatory — and prominent — once it has merged.
			return pr.codeMerged ? "serious" : "triage"
		case "needs-label-and-milestone":
		case "needs-milestone":
		case "blocked-no-code-pr":
			return "triage"
		default:
			return pr.finalReviewActionable || pr.removeLabelFlag || pr.backportLabelFlag
				? "act"
				: "none"
	}
}

// A community thread contributes its own urgency, which can outrank a quiet
// primary category — someone waiting on *you* is serious.
function communitySeverity(pr) {
	if (!pr.community.lit) return "none"
	if (pr.community.waitingOnKind === "operator") return "serious"
	if (pr.community.waitingOnKind === "author") return "none" // visibility only
	return "act"
}

function severityFor(pr) {
	const a = categorySeverity(pr)
	const b = communitySeverity(pr)
	return SEV_RANK[b] > SEV_RANK[a] ? b : a
}

function sortRank(pr) {
	if (pr.category === "needs-close-docs-pr") return 0
	if (pr.category === "needs-escalate-core-team") return 1
	if (pr.category === "needs-followup") return 2
	if (pr.community.lit && pr.community.waitingOnKind === "operator") return 2.5
	if (pr.finalReviewActionable) return 3
	if (pr.category === "needs-operator-review" && pr.codeMerged) return 3.5
	if (pr.category === "needs-remind-code-author") return 4
	if (pr.category === "needs-operator-review" || pr.category === "needs-check-author-response")
		return 5
	if (pr.community.lit) return 5.5
	if (pr.category === "needs-label-and-milestone" || pr.category === "needs-milestone")
		return 6
	if (pr.category === "blocked-no-code-pr") return 7
	return 8
}

function codePRClause(pr) {
	if (!pr.appPRNumber) return "No linked code PR"
	const pillCls = pr.codeClosed ? "closed" : pr.codeMerged ? "merged" : "open"
	const pillText = pr.codeClosed ? "Closed" : pr.codeMerged ? "Merged" : "Open"
	return `Code PR <a href="${pr.appPRUrl}" target="_blank">#${pr.appPRNumber}</a> <span class="pill ${pillCls}">${pillText}</span>`
}

function metaLine(pr) {
	const parts = [codePRClause(pr)]
	if (pr.appPRAuthor) parts.push(`author <b>${escapeHtml(pr.appPRAuthor)}</b>`)

	switch (pr.category) {
		case "needs-close-docs-pr":
			parts.push("code PR closed without merging")
			break
		case "needs-escalate-core-team":
		case "needs-followup":
			parts.push(
				pr.pingEverSent && !pr.lastPingByOperator
					? `${escapeHtml(pr.lastPingActor)} reminded the author, no reply since`
					: "reminded, no reply since",
			)
			break
		case "needs-check-author-response":
			parts.push(`responded ${daysAgoText(pr.lastAuthorEventDate)}`)
			break
		case "needs-remind-code-author":
			parts.push(
				pr.pingEverSent
					? `quiet since your reply ${daysAgoText(pr.lastOperatorTouchDate)}`
					: `you reviewed ${daysAgoText(pr.operatorReviewDate)}`,
			)
			break
		case "needs-operator-review":
			if (pr.hasMilestone && pr.milestoneTitle)
				parts.push(`milestone <b>${escapeHtml(pr.milestoneTitle)}</b>`)
			if (pr.backportLabelFlag)
				parts.push(`targets <b>${escapeHtml(pr.baseBranch)}</b>, no backport label`)
			break
		case "needs-milestone":
			if (pr.backportLabelFlag)
				parts.push(
					`targets <b>${escapeHtml(pr.baseBranch)}</b> (latest ${escapeHtml(pr.latestReleaseBranch || "—")}) · no milestone, no backport label`,
				)
			break
		case "blocked-no-code-pr":
			parts.push(`you reviewed ${daysAgoText(pr.operatorReviewDate)}`)
			break
		case "waiting-code-author-response":
			parts.push(
				pr.pingEverSent && !pr.lastPingByOperator
					? `${escapeHtml(pr.lastPingActor)} reminded the author, waiting for a reply`
					: "reminder sent, waiting for a reply",
			)
			break
		case "waiting-code-pr-merge":
			parts.push("code PR is still open")
			break
	}

	// Approval is a fact worth showing in any band — you always want to know
	// someone pre-approved, even while the code PR is still open.
	if (pr.approvedByNonOperator && pr.approverLogins.length > 0) {
		parts.push(
			`approved by <b>${pr.approverLogins.map(escapeHtml).join(", ")}</b>`,
		)
	}
	if (pr.backportModifierActive) {
		parts.push(
			`targets <b>${escapeHtml(pr.baseBranch)}</b> (latest is <b>${escapeHtml(pr.latestReleaseBranch || "—")}</b>)`,
		)
	}

	return parts.join(" · ")
}

function buildClock(pr) {
	switch (pr.category) {
		case "needs-close-docs-pr":
			return { big: "—", sub: "code PR abandoned" }
		case "needs-escalate-core-team":
			return {
				big: `Day ${pr.daysSincePing}`,
				bigClass: "critical",
				sub: "since reminder",
			}
		case "needs-followup": {
			const pct = Math.min(100, Math.round((pr.daysSincePing / ESCALATE_DAYS) * 100))
			return {
				big: `Day ${pr.daysSincePing}`,
				bigClass: "serious",
				sub: `since reminder · escalate at ${ESCALATE_DAYS}`,
				meterPct: pct,
				meterLate: true,
			}
		}
		case "needs-check-author-response":
			return {
				big: "Replied",
				sub: `${daysAgoText(pr.lastAuthorEventDate)} · clock stopped`,
			}
		case "needs-remind-code-author":
			return pr.pingEverSent
				? { big: "—", sub: `quiet ${pr.daysSinceOperatorTouch}d — ping again` }
				: { big: "—", sub: "no reminder sent yet" }
		case "needs-operator-review":
			return { big: "—", sub: `opened ${daysAgoText(new Date(pr.createdAt))}` }
		case "needs-label-and-milestone":
		case "needs-milestone":
			return { big: "New", sub: "needs triage" }
		case "blocked-no-code-pr":
			return { big: "—", sub: "nobody to remind" }
		case "waiting-code-author-response": {
			const remaining = FOLLOWUP_DAYS - pr.daysSincePing
			const sub = remaining <= 1 ? "follow up tomorrow" : `follow up at ${FOLLOWUP_DAYS}`
			const pct = Math.min(100, Math.round((pr.daysSincePing / FOLLOWUP_DAYS) * 100))
			return { big: `Day ${pr.daysSincePing}`, sub, meterPct: pct }
		}
		case "waiting-code-pr-merge":
			return { big: "—", sub: "waiting for the code PR to merge" }
	}

	// Primary category isn't itself actionable, but a flag is lit.
	if (pr.finalReviewActionable) {
		if (pr.backportModifierActive) {
			return {
				big: "Ready",
				bigClass: "warn",
				sub: "⚠ backport before merging",
				subClass: "warn",
			}
		}
		return { big: "Ready", bigClass: "good", sub: "approved — ready to merge" }
	}
	// Community thread — visibility only, no clock (an @-tag isn't a reliable
	// reminder; a tag of the *author* is handled by the escalation clock above).
	if (pr.community.lit) {
		return {
			big: "👀",
			sub: pr.community.waitingOnKind === "operator" ? "reply needed" : "keep an eye on it",
		}
	}
	return { big: "—", sub: "housekeeping only" }
}

function chipsFor(pr) {
	const chips = []
	switch (pr.category) {
		case "needs-escalate-core-team":
			chips.push({ cls: "nudge3", text: "▲ Escalate to core team" })
			break
		case "needs-followup":
			chips.push({ cls: "nudge2", text: "Send a follow-up" })
			break
		case "needs-remind-code-author":
			chips.push({ cls: "nudge1", text: "Remind the code author" })
			break
		case "needs-check-author-response":
			chips.push({ cls: "act", text: "Check the author’s response" })
			break
		case "needs-operator-review":
			chips.push(
				pr.codeMerged
					? { cls: "act", text: "Review this docs PR — code PR merged" }
					: { cls: "muted", text: "Review this docs PR" },
			)
			break
		case "needs-label-and-milestone":
			if (!pr.hasLabel) chips.push({ cls: "setup", text: `Add ${PENDING_LABEL} label` })
			if (!pr.hasMilestone) chips.push({ cls: "setup", text: "Add milestone" })
			break
		case "needs-milestone":
			chips.push({ cls: "setup", text: "Add milestone" })
			break
		case "blocked-no-code-pr":
			chips.push({ cls: "manual", text: "No code PR linked — needs a manual look" })
			break
		case "needs-close-docs-pr":
			chips.push({ cls: "dismiss", text: "Close this docs PR" })
			break
	}

	// Community thread — names both people so the social action is obvious.
	// A thread waiting on the code author is handled by remindedOpenChip
	// instead (it covers a teammate's tag or your own, on any row, not just
	// this category's), so it's skipped here to avoid a duplicate chip.
	if (pr.community.lit && pr.community.waitingOnKind !== "author") {
		const c = pr.community
		let text
		if (c.waitingOnKind === "untagged") {
			text = `👀 ${escapeHtml(c.commenter)} commented — no reply yet`
		} else if (c.commenterIsOperator) {
			text = `👀 you're waiting on ${escapeHtml(c.waitingOn)}`
		} else {
			text = `👀 ${escapeHtml(c.commenter)} is waiting on ${escapeHtml(c.waitingOn)}`
		}
		chips.push({ cls: "manual", text })
	}

	const reminded = remindedOpenChip(pr)
	if (reminded) chips.push(reminded)

	if (pr.finalReviewActionable) {
		chips.push(
			pr.backportModifierActive
				? { cls: "backport", text: "Final review · backport, then merge" }
				: { cls: "finish", text: "Final review, then merge" },
		)
	}
	if (pr.removeLabelFlag) {
		chips.push({ cls: "finish", text: `Remove ${PENDING_LABEL} label` })
	}
	if (pr.backportLabelFlag) {
		chips.push({ cls: "setup", text: `Add ${BACKPORT_LABEL} label` })
	}

	return chips
}

// A reminder already sent while the code PR is still open — shown on
// whichever row the PR currently lands on (Need-today triage/review, or
// Waiting), so you never duplicate it. Named when a non-operator sent it,
// generic when it was you or a teammate operator (the point is just "already
// pinged", not who).
function remindedOpenChip(pr) {
	if (pr.community.lit && pr.community.waitingOnKind === "author") {
		return {
			cls: "muted",
			text: `${escapeHtml(pr.community.commenter)} reminded the code author`,
		}
	}
	if (pr.remindedWhileOpen) {
		return { cls: "muted", text: "Reminded code PR author" }
	}
	return null
}

// Waiting rows are otherwise chip-free (nothing to *do*).
function waitingChipsFor(pr) {
	const chips = []
	const reminded = remindedOpenChip(pr)
	if (reminded) chips.push(reminded)
	return chips
}

function renderWhen(clock) {
	const bigCls = clock.bigClass ? ` ${clock.bigClass}` : ""
	const subCls = clock.subClass ? ` ${clock.subClass}` : ""
	let meterHtml = ""
	if (clock.meterPct !== undefined) {
		meterHtml = `<div class="meter${clock.meterLate ? " late" : ""}"><i style="width:${clock.meterPct}%"></i></div>`
	}
	return `<div class="when"><div class="days${bigCls}">${clock.big}</div><div class="sub${subCls}">${clock.sub}</div>${meterHtml}</div>`
}

function renderNeedTodayRow(pr) {
	const sev = severityFor(pr)
	const chipsHtml = chipsFor(pr)
		.map((c) => `<span class="chip ${c.cls}">${c.text}</span>`)
		.join("")
	const draftPill = pr.isDraft ? ' <span class="pill draft">Draft</span>' : ""
	return `
      <article class="row" data-sev="${sev}" data-repo="${escapeHtml(pr.repoShort)}">
        <div class="edge"></div>
        <div>
          <div class="title"><a href="${pr.url}" target="_blank" class="name">${escapeHtml(pr.repoShort)} #${pr.number}</a> <span class="desc">${escapeHtml(pr.title)}</span>${draftPill}</div>
          <div class="meta">${metaLine(pr)}</div>
          <div class="chips">${chipsHtml}</div>
        </div>
        ${renderWhen(buildClock(pr))}
      </article>`
}

function renderWaitingRow(pr) {
	const draftPill = pr.isDraft ? ' <span class="pill draft">Draft</span>' : ""
	const chips = waitingChipsFor(pr)
	const chipsHtml = chips.length
		? `<div class="chips">${chips.map((c) => `<span class="chip ${c.cls}">${c.text}</span>`).join("")}</div>`
		: ""
	return `
      <article class="row" data-sev="none" data-repo="${escapeHtml(pr.repoShort)}">
        <div class="edge"></div>
        <div>
          <div class="title"><a href="${pr.url}" target="_blank" class="name">${escapeHtml(pr.repoShort)} #${pr.number}</a> <span class="desc">${escapeHtml(pr.title)}</span>${draftPill}</div>
          <div class="meta">${metaLine(pr)}</div>
          ${chipsHtml}
        </div>
        ${renderWhen(buildClock(pr))}
      </article>`
}

function renderMonitoringRow(pr) {
	const pillCls = pr.codeClosed ? "closed" : pr.codeMerged ? "merged" : "open"
	const pillText = pr.codeClosed ? "Closed" : pr.codeMerged ? "Merged" : "Open"
	const codePart = pr.appPRNumber
		? `<span class="code">Code PR <a href="${pr.appPRUrl}" target="_blank">#${pr.appPRNumber}</a> <span class="pill ${pillCls}">${pillText}</span></span>`
		: `<span class="code">No linked code PR</span>`
	// Day count since the operator's last reply — resurfaces as a reminder
	// prompt once it reaches FOLLOWUP_DAYS (see the category logic in main()).
	const dayText =
		pr.daysSinceOperatorTouch != null
			? `Day ${pr.daysSinceOperatorTouch} since your reply · remind again at ${FOLLOWUP_DAYS}`
			: "quiet"
	return `<div class="mon-row" data-repo="${escapeHtml(pr.repoShort)}"><a href="${pr.url}" target="_blank">${escapeHtml(pr.repoShort)} #${pr.number}</a> ${codePart} <span class="why">${dayText}</span></div>`
}

function formatUpdated(date) {
	return date.toLocaleString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})
}

const EMPTY_LINES = [
	"Every PR is either waiting on someone else or quietly behaving.",
	"Inbox zero, docs edition.",
	"All quiet. The docs can wait — go write some.",
	"No follow-ups, no escalations, no stale labels. Enjoy it.",
	"The review queue is empty. This is not a drill.",
]

function generateHTML(prData, { operatorUsername }) {
	const needToday = prData.filter(isNeedTodayRow)
	const waiting = prData.filter(
		(p) => !isNeedTodayRow(p) && p.category.startsWith("waiting-"),
	)
	const monitoring = prData.filter(
		(p) => !isNeedTodayRow(p) && p.category === "monitoring",
	)

	needToday.sort((a, b) => {
		const ra = sortRank(a)
		const rb = sortRank(b)
		if (ra !== rb) return ra - rb
		const da = a.daysSincePing ?? -1
		const db = b.daysSincePing ?? -1
		return db - da
	})
	waiting.sort((a, b) => {
		if (a.category !== b.category)
			return a.category === "waiting-code-author-response" ? -1 : 1
		return (b.daysSincePing ?? 0) - (a.daysSincePing ?? 0)
	})

	const now = new Date()

	const closeCount = needToday.filter((p) => p.category === "needs-close-docs-pr").length
	const escalateCount = needToday.filter(
		(p) => p.category === "needs-escalate-core-team",
	).length
	const followupCount = needToday.filter((p) => p.category === "needs-followup").length
	const needTodayBits = []
	if (closeCount > 0) needTodayBits.push(`<span class="dot dismiss"></span>${closeCount} to close`)
	if (escalateCount > 0)
		needTodayBits.push(`<span class="dot critical"></span>${escalateCount} overdue`)
	if (followupCount > 0)
		needTodayBits.push(`<span class="dot serious"></span>${followupCount} follow-up`)
	const needTodaySub = needTodayBits.join(" · ")

	const authorWaiting = waiting.filter((p) => p.category === "waiting-code-author-response")
	let waitingSub = "waiting for code PRs to merge"
	if (authorWaiting.length > 0) {
		const minDays = Math.min(
			...authorWaiting.map((p) => FOLLOWUP_DAYS - p.daysSincePing),
		)
		if (minDays <= 0) waitingSub = "next follow-up due today"
		else if (minDays === 1) waitingSub = "next follow-up due tomorrow"
		else waitingSub = `next follow-up due in ${minDays} days`
	}

	// ---- filter tabs (repo + priority) -----------------------------------
	const repoCounts = {}
	for (const p of prData) repoCounts[p.repoShort] = (repoCounts[p.repoShort] || 0) + 1
	const repoList = Object.keys(repoCounts).sort()

	const PRIORITY_TABS = [
		["critical", "Critical"],
		["serious", "Serious"],
		["act", "Act"],
		["triage", "Triage"],
	]
	const sevCounts = { critical: 0, serious: 0, act: 0, triage: 0 }
	for (const p of needToday) {
		const s = severityFor(p)
		if (sevCounts[s] != null) sevCounts[s]++
	}

	const repoTabs = [
		`<button class="ftab active" data-f="repo" data-v="all">All <span class="fc">${prData.length}</span></button>`,
		...repoList.map(
			(r) =>
				`<button class="ftab" data-f="repo" data-v="${escapeHtml(r)}">${escapeHtml(r)} <span class="fc">${repoCounts[r]}</span></button>`,
		),
	].join("")
	const priorityTabs = [
		`<button class="ftab active" data-f="pri" data-v="all">All <span class="fc">${needToday.length}</span></button>`,
		...PRIORITY_TABS.map(
			([v, label]) =>
				`<button class="ftab" data-f="pri" data-v="${v}">${label} <span class="fc">${sevCounts[v]}</span></button>`,
		),
	].join("")
	const filterBar = `
  <div class="filters">
    <div class="fbar"><span class="fbar-label">Repo</span>${repoTabs}</div>
    <div class="fbar"><span class="fbar-label">Priority</span>${priorityTabs}</div>
  </div>`

	const needTodaySection =
		needToday.length > 0
			? `
  <section data-band="today">
    <div class="sec-head">
      <h2>Need you today</h2><span class="count">${needToday.length}</span>
      <span class="hint">actions only you can take — most urgent first</span>
      <span class="no-match">no rows match this filter</span>
    </div>
    <div class="card">${needToday.map(renderNeedTodayRow).join("")}
    </div>
  </section>`
			: `
  <div class="empty">
    <div class="mark">✓</div>
    <h3>Nothing needs you today</h3>
    <p>${EMPTY_LINES[Math.floor(Date.now() / 86400000) % EMPTY_LINES.length]}</p>
    <p class="tail">${waiting.length} waiting on others · ${monitoring.length} monitoring</p>
  </div>`

	const waitingSection =
		waiting.length > 0
			? `
  <section class="band-secondary" data-band="waiting">
    <div class="sec-head">
      <h2>Waiting on others</h2><span class="count">${waiting.length}</span>
      <span class="hint">the ball is in someone else's court — the tracker watches the clock</span>
    </div>
    <div class="card">${waiting.map(renderWaitingRow).join("")}
    </div>
  </section>`
			: ""

	const monitoringSection =
		monitoring.length > 0
			? `
  <section class="band-secondary" data-band="monitoring">
    <div class="sec-head">
      <h2>Monitoring</h2><span class="count">${monitoring.length}</span>
      <span class="hint">healthy — collapsed by default</span>
    </div>
    <div class="card">
      <details class="mon">
        <summary><span class="tw">▶</span> ${monitoring.length} PR${monitoring.length === 1 ? "" : "s"} in a normal back-and-forth — already handled, nothing to do</summary>
        ${monitoring.map(renderMonitoringRow).join("\n        ")}
      </details>
    </div>
  </section>`
			: ""

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docs PR Tracker</title>
<style>
  :root{
    --page:#f9f9f7;
    --surface:#fcfcfb;
    --ink:#0b0b0b;
    --ink-2:#52514e;
    --ink-3:#898781;
    --line:#e1e0d9;
    --ring:rgba(11,11,11,.10);
    --critical:#d03b3b;
    --serious:#ec835a;
    --warning:#fab219;
    --good:#0ca30c;
    --good-ink:#006300;
    --accent:#2a78d6;
    --shadow:0 1px 2px rgba(11,11,11,.05);
    --setup:#0e7490;
    --manual:#c2255c;
    --dismiss:#8a5252;
    --gh-open:#1a7f37;
    --gh-merged:#8250df;
    --gh-closed:#cf222e;
    --gh-draft:#59636e;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7;
      --ink-3:#898781; --line:#2c2c2a; --ring:rgba(255,255,255,.10);
      --good-ink:#0ca30c; --accent:#3987e5; --shadow:none;
      --setup:#26b6d4; --manual:#e57e9f; --dismiss:#c49090;
      --gh-open:#3fb950; --gh-merged:#a371f7; --gh-closed:#f85149; --gh-draft:#b1bac4;
    }
  }
  :root[data-theme="dark"]{
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7;
    --ink-3:#898781; --line:#2c2c2a; --ring:rgba(255,255,255,.10);
    --good-ink:#0ca30c; --accent:#3987e5; --shadow:none;
    --setup:#26b6d4; --manual:#e57e9f; --dismiss:#c49090;
    --gh-open:#3fb950; --gh-merged:#a371f7; --gh-closed:#f85149; --gh-draft:#b1bac4;
  }
  :root[data-theme="light"]{
    --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e;
    --ink-3:#898781; --line:#e1e0d9; --ring:rgba(11,11,11,.10);
    --good-ink:#006300; --accent:#2a78d6; --shadow:0 1px 2px rgba(11,11,11,.05);
    --setup:#0e7490; --manual:#c2255c; --dismiss:#8a5252;
    --gh-open:#1a7f37; --gh-merged:#8250df; --gh-closed:#cf222e; --gh-draft:#59636e;
  }

  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:var(--page); color:var(--ink);
    font-size:14px; line-height:1.45;
    padding:24px 16px 48px;
  }
  .wrap{max-width:1000px;margin:0 auto}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  b{font-weight:600}

  .top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
  .updated{color:var(--ink-3);font-size:12px;margin-right:auto}
  .theme-btn{
    border:1px solid var(--ring);background:var(--surface);color:var(--ink-2);
    border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;
  }

  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .tile{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    padding:14px 16px;box-shadow:var(--shadow);
  }
  .tile .num{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
  .tile .lbl{font-size:13px;font-weight:600;margin-top:2px}
  .tile .sub{font-size:12px;color:var(--ink-3);margin-top:2px}
  .tile.focus{border-top:3px solid var(--accent)}
  .tile.focus .num{color:var(--accent)}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px}
  .dot.critical{background:var(--critical)}
  .dot.serious{background:var(--serious)}
  .dot.dismiss{background:var(--dismiss)}

  .legend{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    box-shadow:var(--shadow);margin-bottom:28px;
  }
  .legend summary{
    list-style:none;cursor:pointer;padding:10px 16px;
    font-size:12.5px;font-weight:600;color:var(--ink-3);
    display:flex;align-items:center;gap:8px;
  }
  .legend summary::-webkit-details-marker{display:none}
  .legend summary .tw{transition:transform .15s;color:var(--ink-3);font-size:10px}
  .legend[open] summary .tw{transform:rotate(90deg)}
  .legend[open] summary{border-bottom:1px solid var(--line);color:var(--ink-2)}
  .legend-body{
    padding:4px 16px 16px;font-size:12.5px;color:var(--ink-2);
  }
  .legend section{margin-top:16px}
  .legend h4{
    font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
    color:var(--ink-3);margin-bottom:6px;
  }
  .legend-note{color:var(--ink-3);font-size:12px;margin-bottom:6px}
  .legend table{width:100%;border-collapse:collapse}
  .legend td{
    padding:6px 10px 6px 0;border-bottom:1px solid var(--line);
    vertical-align:top;line-height:1.5;
  }
  .legend tr:last-child td{border-bottom:none}
  .legend td:first-child{white-space:nowrap;width:1%;padding-right:16px}
  .legend code{
    font-family:ui-monospace,monospace;font-size:11px;
    background:color-mix(in srgb, var(--ink) 6%, transparent);
    border-radius:4px;padding:1px 5px;
  }
  .edge-sample{
    display:inline-block;width:4px;height:14px;border-radius:2px;
    background:var(--accent);vertical-align:-2px;margin-right:2px;
  }

  section{margin-bottom:28px}
  .sec-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap}
  .sec-head h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .sec-head .count{
    font-size:12px;font-weight:600;color:var(--ink-2);
    background:color-mix(in srgb, var(--ink) 7%, transparent);
    border-radius:999px;padding:1px 8px;
  }
  .sec-head .hint{font-size:12px;color:var(--ink-3)}
  .card{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    box-shadow:var(--shadow);overflow:hidden;
  }

  .row{
    display:grid;grid-template-columns:4px 1fr auto;gap:0 14px;
    padding:12px 16px 12px 12px;border-bottom:1px solid var(--line);
    align-items:center;
  }
  .row:last-child{border-bottom:none}
  .row .edge{width:4px;border-radius:2px;background:var(--line);align-self:stretch}
  .row[data-sev="critical"] .edge{background:var(--critical)}
  .row[data-sev="serious"]  .edge{background:var(--serious)}
  .row[data-sev="act"]      .edge{background:var(--accent)}
  .row[data-sev="triage"]   .edge{background:var(--ink-3)}
  .row[data-sev="dismiss"]  .edge{background:var(--dismiss)}

  .row .title{font-size:14px}
  .row .title .name{font-weight:600}
  .row .title .desc{color:var(--ink-2)}
  .row .meta{font-size:12px;color:var(--ink-3);margin-top:2px}
  .row .meta b{color:var(--ink-2);font-weight:600}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}

  .chip{
    display:inline-flex;align-items:center;gap:5px;
    font-size:12px;font-weight:600;border-radius:6px;padding:2.5px 9px;
    border:1px solid transparent;white-space:nowrap;
  }
  .chip.nudge1{
    background:color-mix(in srgb, var(--critical) 8%, var(--surface));
    color:color-mix(in srgb, var(--critical) 55%, var(--ink));
    border-color:color-mix(in srgb, var(--critical) 22%, transparent);
  }
  .chip.nudge2{
    background:color-mix(in srgb, var(--critical) 17%, var(--surface));
    color:color-mix(in srgb, var(--critical) 76%, var(--ink));
    border-color:color-mix(in srgb, var(--critical) 42%, transparent);
  }
  .chip.nudge3{
    background:var(--critical);
    color:#fff;
    border-color:color-mix(in srgb, var(--critical) 70%, var(--ink));
  }
  .chip.setup{
    background:color-mix(in srgb, var(--setup) 11%, var(--surface));
    color:color-mix(in srgb, var(--setup) 75%, var(--ink));
    border-color:color-mix(in srgb, var(--setup) 32%, transparent);
  }
  .chip.act{
    background:color-mix(in srgb, var(--accent) 11%, var(--surface));
    color:color-mix(in srgb, var(--accent) 78%, var(--ink));
    border-color:color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .chip.finish{
    background:color-mix(in srgb, var(--good) 12%, var(--surface));
    color:color-mix(in srgb, var(--good) 62%, var(--ink));
    border-color:color-mix(in srgb, var(--good) 34%, transparent);
  }
  .chip.backport{
    background:color-mix(in srgb, var(--warning) 17%, var(--surface));
    color:color-mix(in srgb, var(--warning) 42%, var(--ink));
    border-color:color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .chip.manual{
    background:color-mix(in srgb, var(--manual) 10%, var(--surface));
    color:color-mix(in srgb, var(--manual) 72%, var(--ink));
    border-color:color-mix(in srgb, var(--manual) 32%, transparent);
  }
  .chip.dismiss{
    background:color-mix(in srgb, var(--dismiss) 13%, var(--surface));
    color:color-mix(in srgb, var(--dismiss) 80%, var(--ink));
    border-color:color-mix(in srgb, var(--dismiss) 40%, transparent);
  }
  /* optional / already-done — same gray as the triage row edge */
  .chip.muted{
    background:color-mix(in srgb, var(--ink-3) 12%, var(--surface));
    color:var(--ink-3);
    border-color:color-mix(in srgb, var(--ink-3) 30%, transparent);
  }

  .pill{
    display:inline-block;font-size:11px;font-weight:600;border-radius:999px;
    padding:1px 7px;vertical-align:1px;
    background:color-mix(in srgb, var(--ink) 7%, transparent);color:var(--ink-2);
  }
  .pill.open{
    background:color-mix(in srgb, var(--gh-open) 13%, var(--surface));
    color:color-mix(in srgb, var(--gh-open) 85%, var(--ink));
  }
  .pill.merged{
    background:color-mix(in srgb, var(--gh-merged) 13%, var(--surface));
    color:color-mix(in srgb, var(--gh-merged) 85%, var(--ink));
  }
  .pill.closed{
    background:color-mix(in srgb, var(--gh-closed) 12%, var(--surface));
    color:color-mix(in srgb, var(--gh-closed) 82%, var(--ink));
  }
  .pill.draft{
    background:color-mix(in srgb, var(--gh-draft) 14%, var(--surface));
    color:var(--gh-draft);
  }

  .when{text-align:right;min-width:96px}
  .when .days{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap}
  .when .days.critical{color:var(--critical)}
  .when .days.serious{color:color-mix(in srgb, var(--serious) 70%, var(--ink))}
  .when .days.good{color:var(--good-ink)}
  .when .days.warn{color:color-mix(in srgb, var(--warning) 45%, var(--ink))}
  .when .sub{font-size:11px;color:var(--ink-3);margin-top:1px}
  .when .sub.warn{color:color-mix(in srgb, var(--warning) 40%, var(--ink-2));font-weight:600}
  .meter{
    width:84px;height:4px;border-radius:2px;background:var(--line);
    margin:5px 0 0 auto;overflow:hidden;
  }
  .meter i{display:block;height:100%;border-radius:2px;background:var(--accent)}
  .meter.late i{background:var(--serious)}

  details.mon summary{
    list-style:none;cursor:pointer;padding:12px 16px;
    font-size:13px;font-weight:600;color:var(--ink-2);
    display:flex;align-items:center;gap:8px;
  }
  details.mon summary::-webkit-details-marker{display:none}
  details.mon summary .tw{transition:transform .15s;color:var(--ink-3);font-size:11px}
  details.mon[open] summary .tw{transform:rotate(90deg)}
  .mon-row{
    display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;
    padding:9px 16px;border-top:1px solid var(--line);font-size:13px;
  }
  .mon-row .code{color:var(--ink-3);font-size:12px}
  .mon-row .why{color:var(--ink-3);font-size:12px;margin-left:auto}

  .empty{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    padding:40px 24px;text-align:center;box-shadow:var(--shadow);
  }
  .empty .mark{
    width:40px;height:40px;border-radius:50%;margin:0 auto 12px;
    display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--good) 14%, var(--surface));
    color:var(--good-ink);font-size:19px;font-weight:700;
  }
  .empty h3{font-size:15px;font-weight:650;margin-bottom:4px}
  .empty p{color:var(--ink-3);font-size:13px}
  .empty .tail{margin-top:10px;font-size:12px;color:var(--ink-3)}

  footer{margin-top:36px;text-align:center;font-size:12px;color:var(--ink-3)}
  footer code{font-family:ui-monospace,monospace;font-size:11px}

  /* ---------- filter tabs ---------- */
  .filters{
    display:flex;flex-direction:column;gap:8px;margin-bottom:24px;
  }
  .fbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .fbar-label{
    font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
    color:var(--ink-3);min-width:64px;
  }
  .ftab{
    font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;
    border:1px solid var(--ring);background:var(--surface);color:var(--ink-2);
    border-radius:999px;padding:4px 11px;display:inline-flex;align-items:center;gap:6px;
  }
  .ftab:hover{border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}
  .ftab.active{
    background:color-mix(in srgb, var(--accent) 12%, var(--surface));
    border-color:color-mix(in srgb, var(--accent) 45%, transparent);
    color:color-mix(in srgb, var(--accent) 80%, var(--ink));
  }
  .ftab .fc{
    font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;
    background:color-mix(in srgb, var(--ink) 8%, transparent);
    border-radius:999px;padding:0 6px;color:var(--ink-2);
  }
  .ftab.active .fc{background:color-mix(in srgb, var(--accent) 22%, transparent)}
  .row.hidden,.mon-row.hidden{display:none}
  .no-match{font-size:12px;color:var(--ink-3);display:none}
  section.all-hidden .no-match{display:inline}
  section.all-hidden .card{display:none}
  /* choosing a specific priority hides the lower-priority bands entirely */
  body:not([data-fpri="all"]) .band-secondary{display:none}

  @media (max-width:640px){
    body{padding:16px 10px 40px}
    .stats{grid-template-columns:1fr;gap:8px}
    .tile{display:flex;align-items:baseline;gap:10px;padding:10px 14px}
    .tile .num{font-size:22px}
    .tile .sub{margin-left:auto;text-align:right}
    .legend td:first-child{white-space:normal;width:auto;display:block;padding-bottom:2px}
    .legend tr{display:block;padding:6px 0;border-bottom:1px solid var(--line)}
    .legend tr td{border-bottom:none;padding-left:0}
    .row{grid-template-columns:4px 1fr;row-gap:6px}
    .when{grid-column:2;text-align:left;display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
    .when .sub{margin-top:0}
    .meter{margin:0}
    .mon-row .why{margin-left:0;width:100%}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <h1>Docs PR Tracker</h1>
    <span class="updated">Updated ${formatUpdated(now)}</span>
    <button class="theme-btn" onclick="toggleTheme()">◐ Theme</button>
  </div>

  <div class="stats">
    <div class="tile focus">
      <div class="num">${needToday.length}</div>
      <div><div class="lbl">Need you today</div>
      <div class="sub">${needTodaySub}</div></div>
    </div>
    <div class="tile">
      <div class="num">${waiting.length}</div>
      <div><div class="lbl">Waiting on others</div>
      <div class="sub">${waitingSub}</div></div>
    </div>
    <div class="tile">
      <div class="num">${monitoring.length}</div>
      <div><div class="lbl">Monitoring</div>
      <div class="sub">already handled — nothing to do</div></div>
    </div>
  </div>
${filterBar}
  <details class="legend">
    <summary><span class="tw">▶</span> New here? How to read this board</summary>
    <div class="legend-body">

      <section>
        <h4>The three bands — whose turn is it?</h4>
        <table>
          <tr><td><b>Need you today</b></td><td>Actions only you can take.</td></tr>
          <tr><td><b>Waiting on others</b></td><td>You've done your part — a clock is running.</td></tr>
          <tr><td><b>Monitoring</b></td><td>The author replied and you've already looked. Collapsed by default — has its own quiet-conversation clock, and resurfaces if it goes quiet for a week.</td></tr>
        </table>
      </section>

      <section>
        <h4>Reading a row</h4>
        <table>
          <tr><td><span class="edge-sample"></span> Left edge</td><td>Urgency at a glance: red overdue → orange due soon → blue actionable → grey triage.</td></tr>
          <tr><td><span class="pill open">Open</span></td><td>A <b>pill</b> — a fact about the PR: Draft / Open / Merged / Closed.</td></tr>
          <tr><td><span class="chip act">Review this docs PR</span></td><td>A <b>chip</b> — an action for you. Colour = task family (below).</td></tr>
        </table>
      </section>

      <section>
        <h4>Colour key — same kind of task, same colour</h4>
        <table>
          <tr><td><span class="chip setup">Setup &amp; triage</span></td><td>Add milestone (every new PR) · Add ${PENDING_LABEL} label (drafts) · Add ${BACKPORT_LABEL} label (older branch)</td></tr>
          <tr><td><span class="chip nudge1">Remind</span> <span class="chip nudge2">Follow up</span> <span class="chip nudge3">Escalate</span></td><td>The nudge ladder — one hue, hotter = more urgent.</td></tr>
          <tr><td><span class="chip act">Review / respond</span></td><td>Review this docs PR · Check the author's response.</td></tr>
          <tr><td><span class="chip finish">Finish &amp; merge</span></td><td>Final review, then merge · Remove ${PENDING_LABEL} label.</td></tr>
          <tr><td><span class="chip backport">Backport first</span></td><td>Must be backported before it can merge.</td></tr>
          <tr><td><span class="chip manual">Manual attention</span></td><td>No code PR linked · someone's waiting on a reply.</td></tr>
          <tr><td><span class="chip muted">Optional / already done</span></td><td>Review while the code PR's still open · a reminder you already sent.</td></tr>
          <tr><td><span class="chip dismiss">Close / dismiss</span></td><td>Close this docs PR — its code PR was abandoned.</td></tr>
        </table>
      </section>

      <section>
        <h4>The escalation clock</h4>
        <p class="legend-note">Only a comment that <b>@-tags the code author</b> starts this clock — yours or a teammate's, but not a plain reply — and it stops the instant the author replies.</p>
        <table>
          <tr><td>Day 0</td><td>Code PR merges, someone @-tags the code author.</td></tr>
          <tr><td>Day ${FOLLOWUP_DAYS}</td><td>Row asks for a follow-up.</td></tr>
          <tr><td>Day ${ESCALATE_DAYS}</td><td>Row asks you to escalate to the core team.</td></tr>
          <tr><td>Any day</td><td>Author replies → clock stops, row asks you to check their response.</td></tr>
        </table>
      </section>

      <section>
        <h4>Good to know</h4>
        <table>
          <tr><td>👀 Live threads</td><td>An unanswered human comment on the docs PR. Orange if someone's waiting on <b>you</b>; otherwise it's just visibility, no clock. Includes Promptless when it tags a reviewer outside your team for feedback.</td></tr>
          <tr><td>Approvals</td><td>"approved by …" is shown as a fact everywhere. The "Final review, then merge" action only appears once the code PR has merged.</td></tr>
          <tr><td>Filtering</td><td>The tabs above filter by <b>repo</b> and <b>priority</b>. Priority counts follow whichever repo is selected.</td></tr>
          <tr><td>Labels</td><td><code>${PENDING_LABEL}</code> — removed once the code PR merges. <code>${BACKPORT_LABEL}</code> — added when a PR targets an older branch than the latest.</td></tr>
        </table>
      </section>

    </div>
  </details>
${needTodaySection}
${waitingSection}
${monitoringSection}
  <footer>Generated by <code>node tracker.js</code> as <code>${escapeHtml(operatorUsername)}</code> · ${formatUpdated(now)}</footer>
</div>

<script>
  function toggleTheme(){
    const r = document.documentElement;
    const cur = r.getAttribute('data-theme');
    r.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  }

  // ---- filter tabs (repo + priority) ----
  const filterState = { repo: 'all', pri: 'all' };
  document.body.setAttribute('data-frepo', 'all');
  document.body.setAttribute('data-fpri', 'all');

  function applyFilters(){
    const { repo, pri } = filterState;
    // A specific priority is meaningful only in "Need you today"; the CSS
    // hides the Waiting/Monitoring bands whenever pri !== 'all'.
    document.querySelectorAll('.row').forEach(function(row){
      const okRepo = repo === 'all' || row.getAttribute('data-repo') === repo;
      const okPri  = pri  === 'all' || row.getAttribute('data-sev')  === pri;
      row.classList.toggle('hidden', !(okRepo && okPri));
    });
    document.querySelectorAll('.mon-row').forEach(function(row){
      const okRepo = repo === 'all' || row.getAttribute('data-repo') === repo;
      row.classList.toggle('hidden', !okRepo);
    });
    // Recompute per-section visible counts and empty states.
    document.querySelectorAll('section[data-band]').forEach(function(sec){
      const rows = sec.querySelectorAll('.row, .mon-row');
      let vis = 0;
      rows.forEach(function(r){ if(!r.classList.contains('hidden')) vis++; });
      const badge = sec.querySelector('.sec-head .count');
      if (badge) badge.textContent = vis;
      const hiddenByBand = sec.classList.contains('band-secondary') && pri !== 'all';
      sec.classList.toggle('all-hidden', vis === 0 && !hiddenByBand);
    });
    // Priority tab counts follow the repo selection — "3 triage" should mean
    // 3 in the repo you're looking at, not 3 across everything. These counts
    // are scoped to "Need you today" only and ignore the *priority* filter
    // itself (each tab shows what it would find if you picked it next).
    const todayRows = document.querySelectorAll('section[data-band="today"] .row');
    const bySev = { critical: 0, serious: 0, act: 0, triage: 0 };
    let repoTotal = 0;
    todayRows.forEach(function(row){
      if (repo !== 'all' && row.getAttribute('data-repo') !== repo) return;
      repoTotal++;
      const sev = row.getAttribute('data-sev');
      if (bySev[sev] != null) bySev[sev]++;
    });
    document.querySelectorAll('.ftab[data-f="pri"]').forEach(function(tab){
      const fc = tab.querySelector('.fc');
      if (!fc) return;
      const v = tab.getAttribute('data-v');
      fc.textContent = v === 'all' ? repoTotal : (bySev[v] || 0);
    });
  }

  document.querySelectorAll('.ftab').forEach(function(tab){
    tab.addEventListener('click', function(){
      const dim = tab.getAttribute('data-f');   // 'repo' | 'pri'
      const val = tab.getAttribute('data-v');
      filterState[dim] = val;
      document.body.setAttribute(dim === 'repo' ? 'data-frepo' : 'data-fpri', val);
      tab.parentElement.querySelectorAll('.ftab').forEach(function(t){
        t.classList.toggle('active', t === tab);
      });
      applyFilters();
    });
  });
</script>
</body>
</html>`

	fs.writeFileSync("tracker-report.html", html)
}

module.exports = { main }

if (require.main === module) {
	main().catch((err) => {
		console.error("❌ Error:", err.message)
		process.exit(1)
	})
}
