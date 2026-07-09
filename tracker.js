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
const NEEDS_REBASE_LABEL = process.env.NEEDS_REBASE_LABEL || "needs-rebase"
const RELEASE_BRANCH_PATTERN = /^\d+\.\d+$/
const FOLLOWUP_DAYS = 7
const ESCALATE_DAYS = 14

const CACHE_PATH = "data/pr-cache.json"
const NO_CACHE = process.argv.includes("--fresh") || process.env.TRACKER_NO_CACHE === "1"

// maintainers.json lists the team's GitHub logins who all count as "the
// operator" (team mode) - see loadConfiguredMaintainers() below. The
// authenticated user always counts too, even if not listed there.
const MAINTAINERS_CONFIG_PATH = "maintainers.json"

function loadConfiguredMaintainers() {
	if (!fs.existsSync(MAINTAINERS_CONFIG_PATH)) return []
	try {
		const raw = JSON.parse(fs.readFileSync(MAINTAINERS_CONFIG_PATH, "utf8"))
		if (!Array.isArray(raw.maintainers)) return []
		return raw.maintainers.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
	} catch (err) {
		console.error(`⚠ Could not parse ${MAINTAINERS_CONFIG_PATH}: ${err.message}`)
		return []
	}
}

const CONFIGURED_OPERATOR_LOGINS = loadConfiguredMaintainers()

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
//
// They return `null` (not []) on failure so the caller can tell "genuinely
// no reviews/comments" apart from "the fetch broke" — a transient error must
// never be mistaken for an empty result and cached as one.
async function fetchPRReviews(repo, number) {
	try {
		return await makeRequest(
			`https://api.github.com/repos/${repo}/pulls/${number}/reviews`,
		)
	} catch (e) {
		console.error(`Error fetching reviews for ${repo}#${number}:`, e.message)
		return null
	}
}

async function fetchIssueComments(repo, number) {
	try {
		return await makeRequest(
			`https://api.github.com/repos/${repo}/issues/${number}/comments`,
		)
	} catch (e) {
		console.error(`Error fetching comments for ${repo}#${number}:`, e.message)
		return null
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
			updatedAt: pr.updated_at,
		}
	} catch (e) {
		console.error(`Error fetching code PR ${repo}#${number}:`, e.message)
		return { merged: false, mergedAt: null, state: "open", author: null, updatedAt: null }
	}
}

// ---------------------------------------------------------------------------
// Cache — committed to the repo (not gitignored) so a scheduled CI run
// starts warm. Keyed by docs-PR identity; each entry's own docs/code
// `updated_at` is the invalidation signature — if neither has moved since
// last run, the (expensive) reviews/comments calls are skipped and the
// cached raw data is reused. Categorization always recomputes fresh from
// whatever data is in hand, cached or not, so a cache bug can produce stale
// *input* but never a stale *category*.
function loadCache() {
	if (NO_CACHE) return {}
	try {
		return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
	} catch {
		return {}
	}
}

function saveCache(cache) {
	fs.mkdirSync("data", { recursive: true })
	fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n")
}

function cacheKey(repo, number) {
	return `${repo}#${number}`
}

// Keep only the fields the derivations actually read. Comments need the
// author, timestamp, and body (for @-mention scanning); reviews need the
// author, state, and timestamp (review bodies are never scanned).
function slimComment(c) {
	return { user: { login: c.user.login }, created_at: c.created_at, body: c.body }
}

function slimReview(r) {
	return { user: { login: r.user.login }, state: r.state, submitted_at: r.submitted_at }
}

function cacheHit(entry, docsUpdatedAt, codeUpdatedAt) {
	if (!entry) return false
	return entry.docsUpdatedAt === docsUpdatedAt && entry.codeUpdatedAt === codeUpdatedAt
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

// Pulls the "X.Y" out of a milestone title like "Mautic 7.2".
function milestoneVersion(title) {
	if (!title) return null
	const m = title.match(/\d+\.\d+/)
	return m ? m[0] : null
}

// A PR targeting an older branch than its own milestone isn't a genuine
// backport — it's aimed at the wrong branch entirely (the milestone says
// where it should land, and it doesn't match). That's what the needs-rebase
// label is for, so it should win over the backport suggestion, not sit
// alongside a suggestion that contradicts it.
function backportContradictsMilestone(baseBranch, milestoneTitle) {
	const mv = milestoneVersion(milestoneTitle)
	return mv !== null && mv !== baseBranch
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
// operator, a teammate, or Promptless (the only bot let in here, since it
// speaks for the docs PR when it relays "I've addressed your feedback") —
// that @-tags the code PR author. Whoever tags the author is effectively
// reminding them, so any such tag starts the remind/follow-up/escalate
// clock (this is what lets a teammate's reminder, or Promptless's, not just
// yours, drive escalation). The @-tag is an unambiguous signal, so no date
// anchor is needed — an old, never-answered tag is still an outstanding
// reminder. Callers pass ping-eligible comments (human + Promptless) as
// docsComments/codeComments here; other derivations elsewhere use the
// strictly-human-filtered versions.
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

	// Tagged with where each ping actually lives — the reminder report (not
	// this clock) cares whether the *latest* one was a docs-PR comment from
	// a human, vs. a code-PR ping or a Promptless relay, which read as "come
	// review" rather than "someone's waiting on a reply to this."
	const taggedDocsComments = docsComments.map((c) => ({ ...c, _pingSource: "docs" }))
	const taggedCodeComments = codeComments.map((c) => ({ ...c, _pingSource: "code" }))
	const pings = appPRAuthor
		? [...taggedDocsComments, ...taggedCodeComments].filter(
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
	const lastPingSource = lastPing ? lastPing._pingSource : null
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
		lastPingSource,
		lastPingByOperator,
		lastOperatorTouchDate,
		lastAuthorEventDate,
	}
}

// The ping logic above is entirely keyed on the *code* PR's author, so it's
// always empty for a docs PR with no linked code PR at all — there's no
// appPRAuthor to tag. This is the equivalent for that case: has anyone
// tagged the docs PR's own author, on the docs PR itself? Used only by the
// reminder report's no-linked-code-PR branch (see buildReminderGroups).
function computeDocsAuthorPing(pingEligibleDocsComments, docsAuthor) {
	if (!docsAuthor) return { date: null, actor: null }
	const pings = pingEligibleDocsComments.filter(
		(c) => c.user.login !== docsAuthor && mentions(c.body, docsAuthor),
	)
	const lastPing = pings.reduce(
		(best, c) =>
			!best || new Date(c.created_at) > new Date(best.created_at) ? c : best,
		null,
	)
	return {
		date: lastPing ? new Date(lastPing.created_at) : null,
		actor: lastPing ? lastPing.user.login : null,
	}
}

// Bots other than promptless-for-oss are always noise. Promptless is the AI
// that drafts these docs PRs and tags a human reviewer when it's addressed
// their feedback — that tag is a genuine "your turn" signal worth surfacing,
// so it's treated as a commenter rather than filtered out.
const IGNORED_BOTS = BOTS.filter((b) => b !== "promptless-for-oss")
const PROMPTLESS = "promptless-for-oss"

// Categories whose own metaLine text already names the ping (who sent it,
// and that it's outstanding or answered) — the "Reminded code PR author"
// badge would just repeat that, so it's skipped for these.
const REMINDER_SHOWN_INLINE = new Set([
	"needs-remind-code-author",
	"needs-check-author-response",
	"needs-followup",
	"needs-escalate-core-team",
	"waiting-code-author-response",
	"monitoring",
])

// A live thread on the *docs* PR (never the code PR) that isn't the
// operator's own author-reminder (those are pings, handled above). Answers
// "who is waiting on whom": first, independently, whether a non-operator
// tag of the code author is still unanswered (checked on its own, since a
// later unrelated exchange with someone else shouldn't bury it); otherwise,
// from the single most recent qualifying docs-PR comment that nobody has
// answered — someone waiting on you, on a third party (including promptless
// chasing a reviewer), or an untagged comment you must triage.
function computeCommunityThread({ rawDocsComments, rawDocsReviews, operatorLogins, appPRAuthor }) {
	const none = { lit: false }
	const comments = rawDocsComments.filter((c) => !IGNORED_BOTS.includes(c.user.login))
	if (comments.length === 0) return none
	const reviews = rawDocsReviews.filter((r) => !IGNORED_BOTS.includes(r.user.login))

	// Independent check: the most recent tag of the code PR author on the
	// docs PR, and whether they've replied since — checked on its own, not
	// gated by whatever the single latest comment overall happens to be
	// about. A later, unrelated exchange with someone else (e.g. Promptless
	// replying to you) shouldn't hide an author-directed tag that's still
	// sitting unanswered. A tag *from* an operator is skipped here — that's
	// a reminder, tracked by the escalation clock instead.
	if (appPRAuthor) {
		const authorTags = comments.filter(
			(c) => c.user.login !== appPRAuthor && mentions(c.body, appPRAuthor),
		)
		const lastAuthorTag = authorTags.reduce(
			(best, c) => (!best || new Date(c.created_at) > new Date(best.created_at) ? c : best),
			null,
		)
		if (lastAuthorTag && !operatorLogins.has(lastAuthorTag.user.login.toLowerCase())) {
			const tagDate = new Date(lastAuthorTag.created_at)
			const answeredByAuthor = [...comments, ...reviews].some(
				(e) =>
					e.user.login === appPRAuthor &&
					new Date(e.submitted_at || e.created_at) > tagDate,
			)
			if (!answeredByAuthor) {
				return {
					lit: true,
					commenter: lastAuthorTag.user.login,
					commenterIsOperator: false,
					waitingOn: appPRAuthor,
					waitingOnKind: "author",
					date: tagDate,
				}
			}
		}
	}

	const last = comments.reduce((best, c) =>
		new Date(c.created_at) > new Date(best.created_at) ? c : best,
	)
	const commenter = last.user.login
	const lastDate = new Date(last.created_at)
	const commenterIsPromptless = commenter === PROMPTLESS

	// The docs PR author working on their own PR isn't "someone waiting."
	if (!commenterIsPromptless && appPRAuthor && commenter === appPRAuthor) return none

	// Answered already? Any later qualifying comment/review by someone else.
	const answered = [...comments, ...reviews].some((e) => {
		const who = e.user.login
		const when = new Date(e.submitted_at || e.created_at)
		return who !== commenter && when > lastDate
	})
	if (answered) return none

	// Ignore self-mentions, any @-mention of a known bot, and a tag of the
	// code author — the author case is already fully handled above (either
	// surfaced there as unanswered, or, if the tagger was an operator,
	// deliberately left to the escalation clock instead). Without this, an
	// operator's own tag of the author would fall through and get
	// mislabeled as "waiting on a third party" below.
	const tagged = extractMentions(last.body).filter(
		(t) =>
			t !== commenter.toLowerCase() &&
			!BOTS.includes(t) &&
			t !== (appPRAuthor || "").toLowerCase(),
	)
	const commenterIsOperator = operatorLogins.has(commenter.toLowerCase())

	if (commenterIsPromptless) {
		// Only worth surfacing if promptless tagged a real reviewer outside
		// the operator/team — that's "go check what they asked for changes
		// on, promptless just addressed it." A tag of you/your team (you'll
		// see it yourself) or no tag at all is not worth a row. (A tag of
		// the code author was already handled above, independently.)
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

	const cache = loadCache()
	let cacheHits = 0
	let cacheMisses = 0
	let fetchFailures = 0

	const prData = []
	for (let i = 0; i < allPRs.length; i++) {
		const pr = allPRs[i]
		process.stdout.write(`\r  Processing PR ${i + 1}/${allPRs.length}`)

		const isDraft = pr.draft
		const hasLabel = pr.labels.some((l) => l.name === PENDING_LABEL)
		const hasBackportLabel = pr.labels.some((l) => l.name === BACKPORT_LABEL)
		const hasNeedsRebaseLabel = pr.labels.some((l) => l.name === NEEDS_REBASE_LABEL)
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
		let codeUpdatedAt = null

		if (appPRData) {
			appPRRepo = appPRData.repo
			appPRNumber = appPRData.number
			appPRUrl = `https://github.com/${appPRRepo}/pull/${appPRNumber}`
			const codePR = await fetchCodePR(appPRRepo, appPRNumber)
			codeMerged = codePR.merged
			codeMergedDate = codePR.mergedAt
			codeClosed = codePR.state === "closed" && !codePR.merged
			appPRAuthor = codePR.author
			codeUpdatedAt = codePR.updatedAt
		}

		// Raw lists keep the bots (needed by the community detector); the human
		// lists drive all the participant logic (reviews, pings, responses).
		// If neither PR has changed since the last run (same updated_at on
		// both), reuse the cached raw data instead of refetching it.
		const key = cacheKey(pr.sourceRepo, pr.number)
		const cached = cache[key]
		let rawDocsReviews
		let rawDocsComments
		let rawCodeComments
		let rawCodeReviews

		if (cacheHit(cached, pr.updated_at, codeUpdatedAt)) {
			;({ rawDocsReviews, rawDocsComments, rawCodeComments, rawCodeReviews } = cached)
			cacheHits++
		} else {
			const dReviews = await fetchPRReviews(pr.sourceRepo, pr.number)
			const dComments = await fetchIssueComments(pr.sourceRepo, pr.number)
			const cComments = appPRNumber
				? await fetchIssueComments(appPRRepo, appPRNumber)
				: []
			const cReviews = appPRNumber ? await fetchPRReviews(appPRRepo, appPRNumber) : []

			// If any of the four fetches failed (null), don't trust this run's
			// data for the PR: fall back to the previous cache entry if we have
			// one (stale but correct), and DON'T overwrite it — so a transient
			// error never poisons the cache with an empty result. Next run
			// retries because the (unchanged) entry still fails the hit check
			// only if updated_at moved; if it didn't, the good cached data is
			// simply reused.
			if (dReviews === null || dComments === null || cComments === null || cReviews === null) {
				console.error(`  ⚠ fetch failed for ${key} — keeping previous cache entry`)
				if (cached) {
					;({ rawDocsReviews, rawDocsComments, rawCodeComments, rawCodeReviews } = cached)
				} else {
					rawDocsReviews = []
					rawDocsComments = []
					rawCodeComments = []
					rawCodeReviews = []
				}
				fetchFailures++
			} else {
				// Slim to just the fields the derivations read, so the committed
				// cache stays small and its diffs stay readable.
				rawDocsReviews = dReviews.map(slimReview)
				rawDocsComments = dComments.map(slimComment)
				rawCodeComments = cComments.map(slimComment)
				rawCodeReviews = cReviews.map(slimReview)
				cache[key] = {
					docsUpdatedAt: pr.updated_at,
					codeUpdatedAt,
					rawDocsReviews,
					rawDocsComments,
					rawCodeComments,
					rawCodeReviews,
				}
				cacheMisses++
			}
		}

		const docsReviews = rawDocsReviews.filter((r) => isHuman(r.user.login))
		const docsComments = rawDocsComments.filter((c) => isHuman(c.user.login))
		const codeComments = rawCodeComments.filter((c) => isHuman(c.user.login))
		const codeReviews = rawCodeReviews.filter((r) => isHuman(r.user.login))

		// Promptless relaying "I've addressed your feedback" while tagging the
		// code PR author functions exactly like a human teammate's reminder —
		// the one bot action let into ping detection, since every other bot
		// comment is pure noise there. Used only for the ping clock below, not
		// for operatorReviewDate/approvals (promptless's login never matches
		// an operator or the author, so it's a no-op for those anyway).
		const pingEligibleDocsComments = rawDocsComments.filter(
			(c) => isHuman(c.user.login) || c.user.login === PROMPTLESS,
		)
		const pingEligibleCodeComments = rawCodeComments.filter(
			(c) => isHuman(c.user.login) || c.user.login === PROMPTLESS,
		)

		// Only meaningful (and only computed) for docs PRs with no linked code
		// PR — see computeDocsAuthorPing above.
		const { date: docsAuthorPingDate, actor: docsAuthorPingActor } = computeDocsAuthorPing(
			pingEligibleDocsComments,
			pr.user.login,
		)
		// The docs PR author's own most recent activity — the equivalent of
		// lastAuthorEventDate, but for the docs PR's own author rather than a
		// linked code PR's author. Powers the standalone-PR clock below.
		const docsAuthorLastEventDate = latestDate([
			...docsComments
				.filter((c) => c.user.login === pr.user.login)
				.map((c) => new Date(c.created_at)),
			...docsReviews
				.filter((r) => r.user.login === pr.user.login)
				.map((r) => new Date(r.submitted_at)),
		])

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
		// Most recent APPROVED review on the docs PR, by anyone (operator
		// included). Only read by the reminder report (buildReminderGroups) to
		// compare against the last ping — whichever happened more recently
		// decides if the approval or an outstanding comment "wins."
		const lastApprovalDate = latestDate(
			docsReviews.filter((r) => r.state === "APPROVED").map((r) => new Date(r.submitted_at)),
		)

		const {
			lastPingDate,
			lastPingActor,
			lastPingSource,
			lastPingByOperator,
			lastOperatorTouchDate,
			lastAuthorEventDate,
		} = computeConversationState({
			docsComments: pingEligibleDocsComments,
			docsReviews,
			codeComments: pingEligibleCodeComments,
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

		// §5a — independent action flags.
		//
		// The final-review action ("do the review, then merge") is only
		// offered once the code PR has merged (or when there's no linked code
		// PR) — while the code PR is still open we don't merge the docs PR, so
		// a non-operator approval is surfaced as a *fact* (approved by X) on a
		// waiting row rather than as a merge action.
		let removeLabelFlag = codeMerged && hasLabel
		let finalReviewActionable = approvedByNonOperator && (codeMerged || !appPRNumber)
		// Just a label check — no clock, no "since when". You put the label on
		// (or a bot did); this just makes sure it doesn't go unnoticed.
		let needsRebaseFlag = hasNeedsRebaseLabel
		// If the PR is already flagged as needing a rebase AND its milestone
		// doesn't match the branch it's targeting, the branch itself is wrong
		// — rebase wins, so neither the backport-label suggestion nor the
		// "backport, then merge" framing below should sit alongside it; both
		// would contradict "the branch needs fixing first."
		let rebaseWinsOverBackport =
			needsRebaseFlag && backportContradictsMilestone(baseBranch, milestoneTitle)
		let backportLabelFlag = olderBranch && !hasBackportLabel && !rebaseWinsOverBackport
		if (codeClosed) {
			removeLabelFlag = false
			finalReviewActionable = false
			backportLabelFlag = false
			needsRebaseFlag = false
			rebaseWinsOverBackport = false
		}
		const backportModifierActive =
			finalReviewActionable && olderBranch && !rebaseWinsOverBackport

		// Plain inactivity signal — nothing has happened on either PR (docs
		// or linked code) for 30+ days. Independent of category, so it can
		// surface even on a row that otherwise looks fine (e.g. quietly
		// "monitoring").
		const lastActivityDate = latestDate(
			[pr.updated_at, codeUpdatedAt].filter(Boolean).map((d) => new Date(d)),
		)
		const daysSinceActivity = lastActivityDate
			? Math.floor((Date.now() - lastActivityDate.getTime()) / 86400000)
			: null
		const staleFlag = daysSinceActivity !== null && daysSinceActivity > 30

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
			// A standalone docs PR has no linked code PR to wait on, so unlike
			// the code-author clock below, your own review is itself the ask
			// — no explicit @-tag is required to start counting, since
			// there's no merge to defer to instead.
			//
			// A non-operator approval settles it the same way it does the
			// code-author flow — unless it still needs a rebase, since a
			// wrong branch target is worth flagging regardless of content
			// approval.
			if (approvedByNonOperator && !needsRebaseFlag) {
				category = "monitoring"
			} else if (
				docsAuthorLastEventDate &&
				lastOperatorTouchDate &&
				docsAuthorLastEventDate > lastOperatorTouchDate
			) {
				// They've replied since your most recent touch — come take a
				// look. (Anchored on your *latest* comment/review, not the
				// first one — you may well have looked more than once.)
				category = "needs-check-author-response"
			} else {
				const daysSinceReview = Math.floor(
					(Date.now() - lastOperatorTouchDate.getTime()) / 86400000,
				)
				if (daysSinceReview >= ESCALATE_DAYS) category = "needs-escalate-core-team"
				else if (daysSinceReview >= FOLLOWUP_DAYS) category = "needs-followup"
				else category = "blocked-no-code-pr"
			}
		} else if (isDraft && (!hasLabel || !hasMilestone)) {
			category = "needs-label-and-milestone"
		} else if (!isDraft && !hasMilestone) {
			category = "needs-milestone"
		} else if (appPRNumber && codeMerged) {
			// The remind/follow-up/escalate clock no longer waits on a formal
			// docs-PR review — some docs PRs need no content changes at all,
			// so review is skipped by design and you wait for the code
			// author to confirm instead. Whether you've reviewed is tracked
			// separately (reviewPendingFlag below) as an overlay chip, not a
			// gate on this chain.
			//
			// An approval from anyone other than a maintainer — the code
			// author themselves, or a community reviewer — outranks the
			// clock entirely: maintainers typically approve *last*, as a
			// final sign-off, so a non-maintainer approval is a strong,
			// independent signal that content-wise this is done. No more
			// nudging; it settles into monitoring like a normal reply would.
			if (devApproved || approvedByNonOperator) {
				category = "monitoring"
			} else if (!pingEverSent) {
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
		} else if (hasMilestone && !operatorReviewDone) {
			category = "needs-operator-review"
		} else if (operatorReviewDone && appPRNumber && !codeMerged) {
			// Code PR still open — don't start any clock, just wait.
			category = "waiting-code-pr-merge"
		} else {
			category = "monitoring"
		}

		// Independent flag: the code PR merged but you haven't formally
		// reviewed the docs PR yet. The clock above no longer waits on that
		// (see the comment above), so this just keeps "you still haven't
		// reviewed it" visible as its own chip alongside whatever the clock
		// is showing, instead of being lost.
		const reviewPendingFlag = appPRNumber && codeMerged && !operatorReviewDone

		// Already pinged the code author (on either PR), and the fact isn't
		// already narrated by the category's own metaLine text above (the
		// post-merge remind/follow-up/escalate categories all name the ping
		// inline). Mainly covers the pre-merge "still open" case, plus any
		// PR still stuck in triage (needs-milestone etc.) despite an
		// already-sent ping.
		const remindedWhileOpen =
			pingEverSent && appPRNumber && !codeClosed && !REMINDER_SHOWN_INLINE.has(category)

		prData.push({
			title: pr.title,
			number: pr.number,
			sourceRepo: pr.sourceRepo,
			repoShort: pr.sourceRepo.split("/")[1].replace("-new", ""),
			url: pr.html_url,
			docsAuthor: pr.user.login,
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
			lastApprovalDate,
			docsAuthorPingDate,
			docsAuthorPingActor,
			pingEverSent,
			lastPingDate,
			lastPingActor,
			lastPingSource,
			lastPingByOperator,
			daysSincePing,
			lastOperatorTouchDate,
			daysSinceOperatorTouch,
			lastAuthorEventDate,
			docsAuthorLastEventDate,
			reviewPendingFlag,
			community,
			remindedWhileOpen,
			removeLabelFlag,
			finalReviewActionable,
			backportLabelFlag,
			needsRebaseFlag,
			backportModifierActive,
			rebaseWinsOverBackport,
			daysSinceActivity,
			staleFlag,
			category,
		})
	}

	// Drop entries for docs PRs no longer open (merged/closed) so the cache
	// file doesn't grow forever.
	const liveKeys = new Set(allPRs.map((pr) => cacheKey(pr.sourceRepo, pr.number)))
	for (const key of Object.keys(cache)) {
		if (!liveKeys.has(key)) delete cache[key]
	}
	saveCache(cache)

	const failNote = fetchFailures > 0 ? `, ${fetchFailures} fetch failed (kept prior)` : ""
	console.log(
		`\n✅ Done! 📦 cache: ${cacheHits} reused, ${cacheMisses} fetched${failNote}\n`,
	)

	generateHTML(prData, { operatorUsername: authenticatedUser })
	console.log("📄 Report saved to: tracker-report.html")

	generateReminderHTML(buildReminderGroups(prData), { now: new Date() })
	console.log("📄 Reminders saved to: tracker-reminders.html")
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
// party, or untagged — does. Exception: once you've reviewed the docs PR
// and its code PR is still open, that's a pure waiting state by design —
// only review status should gate Need-today vs. Waiting there, so a live
// thread on top of it stays visible (via waitingChipsFor) without pulling
// the row back into Need-today.
function communityForcesToday(pr) {
	if (pr.category === "waiting-code-pr-merge") return false
	return pr.community.lit && pr.community.waitingOnKind !== "author"
}

function isNeedTodayRow(pr) {
	return (
		ACTIONABLE_CATEGORIES.has(pr.category) ||
		pr.finalReviewActionable ||
		pr.removeLabelFlag ||
		pr.backportLabelFlag ||
		pr.needsRebaseFlag ||
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

// needs-followup/needs-escalate-core-team/needs-check-author-response are
// shared by two clocks: the code-author one (anchored on the last ping) and
// the standalone-docs-PR one (anchored on your own review, no linked code
// PR to wait on) — this picks whichever anchor actually applies.
function clockDaysSince(pr) {
	const anchor = pr.appPRNumber ? pr.lastPingDate : pr.lastOperatorTouchDate
	return anchor ? Math.floor((Date.now() - anchor.getTime()) / 86400000) : null
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
		case "needs-label-and-milestone":
		case "needs-milestone":
		case "blocked-no-code-pr":
			return "triage"
		default:
			return pr.finalReviewActionable ||
				pr.removeLabelFlag ||
				pr.backportLabelFlag ||
				pr.needsRebaseFlag ||
				pr.reviewPendingFlag
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
	// A stale PR isn't a fresh nudge candidate anymore (see chipsFor) — it's a
	// human decision, not an action tier, so it drops below every other row
	// regardless of category.
	if (pr.staleFlag) return 100
	if (pr.category === "needs-close-docs-pr") return 0
	if (pr.category === "needs-label-and-milestone" || pr.category === "needs-milestone")
		return 1
	if (pr.category === "needs-escalate-core-team") return 2
	if (pr.category === "needs-followup") return 3
	if (pr.community.lit && pr.community.waitingOnKind === "operator") return 3.5
	if (pr.category === "needs-remind-code-author") return 4
	if (pr.finalReviewActionable) return pr.backportModifierActive ? 5 : 6
	if (pr.category === "needs-operator-review" || pr.category === "needs-check-author-response")
		return 7
	if (pr.community.lit) return 7.5
	if (pr.category === "blocked-no-code-pr") return 8
	return 9
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
			if (!pr.appPRNumber) {
				parts.push(`docs author <b>${escapeHtml(pr.docsAuthor)}</b>`)
				parts.push(`no reply since your review ${daysAgoText(pr.lastOperatorTouchDate)}`)
			} else {
				parts.push(
					pr.pingEverSent && !pr.lastPingByOperator
						? `${escapeHtml(pr.lastPingActor)} reminded the author, no reply since`
						: "reminded, no reply since",
				)
			}
			break
		case "needs-check-author-response":
			if (!pr.appPRNumber) parts.push(`docs author <b>${escapeHtml(pr.docsAuthor)}</b>`)
			parts.push(
				`responded ${daysAgoText(pr.appPRNumber ? pr.lastAuthorEventDate : pr.docsAuthorLastEventDate)}`,
			)
			break
		case "needs-remind-code-author":
			if (pr.pingEverSent) {
				parts.push(`quiet since your reply ${daysAgoText(pr.lastOperatorTouchDate)}`)
			} else if (pr.operatorReviewDone) {
				parts.push(`you reviewed ${daysAgoText(pr.operatorReviewDate)}`)
			}
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
			parts.push(`docs author <b>${escapeHtml(pr.docsAuthor)}</b>`)
			parts.push(`you reviewed ${daysAgoText(pr.lastOperatorTouchDate)}`)
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
	if (pr.rebaseWinsOverBackport) {
		parts.push(
			`targets <b>${escapeHtml(pr.baseBranch)}</b>, milestone <b>${escapeHtml(pr.milestoneTitle)}</b> — wrong branch, not a backport`,
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
				big: `Day ${clockDaysSince(pr)}`,
				bigClass: "critical",
				sub: pr.appPRNumber ? "since reminder" : "since your review",
			}
		case "needs-followup": {
			const days = clockDaysSince(pr)
			const pct = Math.min(100, Math.round((days / ESCALATE_DAYS) * 100))
			return {
				big: `Day ${days}`,
				bigClass: "serious",
				sub: `${pr.appPRNumber ? "since reminder" : "since your review"} · escalate at ${ESCALATE_DAYS}`,
				meterPct: pct,
				meterLate: true,
			}
		}
		case "needs-check-author-response":
			return {
				big: "Replied",
				sub: `${daysAgoText(pr.appPRNumber ? pr.lastAuthorEventDate : pr.docsAuthorLastEventDate)} · clock stopped`,
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
			return { big: "—", sub: "remind the docs author" }
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
	// Needs-rebase and stale are structural/status flags, not action nudges —
	// lead with them so they're never buried under a list of chips.
	const leadingStale = staleChip(pr)
	if (leadingStale) chips.push(leadingStale)
	if (pr.needsRebaseFlag) chips.push({ cls: "manual", text: "Needs rebase" })
	// Once a PR has gone quiet for 30+ days, "send a follow-up" / "escalate"
	// / "remind them" stops being an honest next step — it's not a fresh
	// nudge anymore, it's a stale situation that needs a human decision, not
	// another automated poke. The stale badge (added above) covers it instead.
	switch (pr.category) {
		case "needs-escalate-core-team":
			if (!pr.staleFlag) chips.push({ cls: "nudge3", text: "▲ Escalate to core team" })
			break
		case "needs-followup":
			if (!pr.staleFlag) chips.push({ cls: "nudge2", text: "Send a follow-up" })
			break
		case "needs-remind-code-author":
			if (!pr.staleFlag) {
				chips.push({
					cls: "nudge1",
					text: pr.pingEverSent
						? "Remind the code author again — quiet"
						: "Remind code PR author — code PR merged",
				})
			}
			break
		case "needs-check-author-response":
			chips.push({ cls: "act", text: "Check the author’s response" })
			break
		case "needs-operator-review":
			chips.push({ cls: "muted", text: "Review this docs PR" })
			break
		case "needs-label-and-milestone":
			if (!pr.hasLabel) chips.push({ cls: "setup", text: `Add ${PENDING_LABEL} label` })
			if (!pr.hasMilestone) chips.push({ cls: "setup", text: "Add milestone" })
			break
		case "needs-milestone":
			chips.push({ cls: "setup", text: "Add milestone" })
			break
		case "blocked-no-code-pr":
			// A non-operator approval settles it too, same as the code-author
			// clock above — unless it still needs a rebase, since the branch
			// itself being wrong is a reason to keep nagging regardless of
			// content approval.
			if (!pr.staleFlag && (!pr.approvedByNonOperator || pr.needsRebaseFlag)) {
				chips.push({ cls: "manual", text: "Remind docs PR author — no code PR linked" })
			}
			break
		case "needs-close-docs-pr":
			chips.push({ cls: "dismiss", text: "Close this docs PR" })
			break
	}

	const community = communityChip(pr)
	if (community) chips.push(community)

	const reminded = remindedOpenChip(pr)
	if (reminded) chips.push(reminded)

	if (pr.reviewPendingFlag) {
		chips.push({ cls: "act", text: "Review this docs PR — code PR merged" })
	}

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

// No activity on either PR for 30+ days — a plain inactivity signal, not
// tied to any category, so it can flag a row even when nothing else does.
function staleChip(pr) {
	if (!pr.staleFlag) return null
	return { cls: "stale", text: `🕸 Stale — ${pr.daysSinceActivity}d quiet` }
}

// Community thread — names both people so the social action is obvious. A
// thread waiting on the code author is handled by remindedOpenChip instead
// (it covers a teammate's tag or your own, on any row, not just this
// category's), so it's skipped here to avoid a duplicate chip. Shown on
// Need-today and Waiting rows alike — reviewed-but-code-still-open rows no
// longer get pulled into Need-today just for having one (see
// communityForcesToday), so this is what keeps the thread visible there.
function communityChip(pr) {
	if (!pr.community.lit || pr.community.waitingOnKind === "author") return null
	const c = pr.community
	const text =
		c.waitingOnKind === "untagged"
			? `👀 ${escapeHtml(c.commenter)} commented — no reply yet`
			: `👀 ${escapeHtml(c.commenter)} is waiting on ${escapeHtml(c.waitingOn)}`
	return { cls: "manual", text }
}

// Two overlapping "someone's waiting on the code author" signals, shown on
// whichever row the PR currently lands on (Need-today, Waiting, or
// Monitoring) so it's never lost, never duplicated: a live, still-unanswered
// tag from a non-operator (community.waitingOnKind === "author") renders as
// a "waiting on" chip; once *you've* pinged them (any category, tracked via
// remindedWhileOpen), it's a done-fact "already reminded" chip instead.
function remindedOpenChip(pr) {
	// Skip this when the category already narrates the same outstanding tag
	// inline (e.g. needs-followup's "X reminded the author, no reply
	// since") — now that Promptless's tags feed the ping clock too, that's
	// the common case post-merge; this chip is left to cover what the clock
	// can't reach, mainly pre-merge (waiting-code-pr-merge has no clock yet).
	if (
		pr.community.lit &&
		pr.community.waitingOnKind === "author" &&
		!REMINDER_SHOWN_INLINE.has(pr.category)
	) {
		return {
			cls: "manual",
			text: `👀 ${escapeHtml(pr.community.commenter)} is waiting on ${escapeHtml(pr.community.waitingOn)}`,
		}
	}
	if (pr.remindedWhileOpen) {
		return { cls: "muted", text: "✅ Reminded code PR author" }
	}
	return null
}

function waitingChipsFor(pr) {
	const chips = []
	const stale = staleChip(pr)
	if (stale) chips.push(stale)
	const community = communityChip(pr)
	if (community) chips.push(community)
	const reminded = remindedOpenChip(pr)
	if (reminded) chips.push(reminded)
	if (pr.reviewPendingFlag) {
		chips.push({ cls: "act", text: "Review this docs PR — code PR merged" })
	}
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
      <article class="row" data-sev="${sev}" data-repo="${escapeHtml(pr.repoShort)}" data-stale="${pr.staleFlag ? "1" : "0"}">
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
      <article class="row" data-sev="none" data-repo="${escapeHtml(pr.repoShort)}" data-stale="${pr.staleFlag ? "1" : "0"}">
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
	// Overlay flags apply regardless of band — a monitoring row can still be
	// waiting on the author for something unrelated (community), still need
	// a formal review, or just be stale, none of which the day-count above
	// captures on its own.
	const overlayChips = [staleChip(pr), remindedOpenChip(pr)]
		.filter(Boolean)
		.map((c) => `<span class="chip ${c.cls}">${c.text}</span>`)
		.join("")
	const reviewChip = pr.reviewPendingFlag
		? `<span class="chip act">Review this docs PR — code PR merged</span>`
		: ""
	return `<div class="mon-row" data-repo="${escapeHtml(pr.repoShort)}" data-stale="${pr.staleFlag ? "1" : "0"}"><a href="${pr.url}" target="_blank">${escapeHtml(pr.repoShort)} #${pr.number}</a> ${codePart} <span class="why">${dayText}</span>${reviewChip}${overlayChips}</div>`
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

// ---------------------------------------------------------------------------
// Reminder report (tracker-reminders.html) — a separate, code-PR-author-
// facing page grouping "things waiting on you" per author, meant to be
// shared directly with them.
// ---------------------------------------------------------------------------

// Two shapes of "the ball is in a human's court," both covered by this
// report:
//  - A linked code PR that's merged, still in the post-merge remind/
//    follow-up/escalate chain — remind its author. Once *they've* replied
//    (needs-check-author-response, monitoring) it's someone else's turn.
//  - No linked code PR at all (blocked-no-code-pr) — a standalone docs
//    contribution where you've already reviewed/commented. Remind the docs
//    PR's own author instead, but only if someone's actually tagged them —
//    a PR they've simply gone quiet on (nobody currently asking them
//    anything) isn't their turn, it's just unattended.
const REMINDER_ELIGIBLE_CATEGORIES = new Set([
	"needs-remind-code-author",
	"waiting-code-author-response",
	"needs-followup",
	"needs-escalate-core-team",
])

// Whether there's a genuine, still-live reason to ping the code author: a
// human (not Promptless) tagged them directly on the docs PR, and — this is
// the part that matters — that tag is *more recent than the last approval*
// (or there's no approval at all yet). An approval doesn't retroactively
// erase an earlier tag that's still unanswered, but it does settle things
// once nothing's tagged them since. Whichever happened last wins.
function hasOutstandingDocsPing(pr) {
	return (
		pr.pingEverSent &&
		pr.lastPingSource === "docs" &&
		pr.lastPingActor !== PROMPTLESS &&
		(!pr.lastApprovalDate || pr.lastPingDate > pr.lastApprovalDate)
	)
}

// Default is "Need review". That flips to "Response to comment from X" only
// when hasOutstandingDocsPing says there's a live, unanswered tag; anything
// else (a code-PR-side tag, a Promptless relay, or a tag that's older than
// the latest approval) reads as "come look," not "reply to this."
function reminderMark(pr) {
	if (hasOutstandingDocsPing(pr)) {
		return { kind: "respond", who: pr.lastPingActor, sortDate: pr.lastPingDate }
	}
	return {
		kind: "review",
		sortDate: pr.pingEverSent ? pr.lastPingDate : pr.codeMergedDate || pr.operatorReviewDate,
	}
}

// The no-linked-code-PR branch's equivalent of hasOutstandingDocsPing,
// using docsAuthorPingDate/Actor instead. There's no "Need review" default
// here, unlike the code-author branch — a merged code PR is its own
// trigger to come review the docs, but a standalone docs PR has no such
// automatic moment, so this branch only ever includes a PR when someone's
// actually tagged its author and that tag is still live.
function hasOutstandingDocsAuthorPing(pr) {
	return (
		pr.docsAuthorPingDate !== null &&
		pr.docsAuthorPingActor !== PROMPTLESS &&
		(!pr.lastApprovalDate || pr.docsAuthorPingDate > pr.lastApprovalDate)
	)
}

// Grouped by whoever needs to act (never a bot — Promptless included),
// sorted alphabetically so the page reads like a directory; each person's
// own items are oldest-first, since that's the most overdue.
function buildReminderGroups(prData) {
	const groups = new Map()
	for (const pr of prData) {
		// A stale PR (30+ days of no activity anywhere) is a call for you or
		// the team to make, not something to push onto an external
		// contributor automatically.
		if (pr.staleFlag) continue

		let remindLogin
		let mark
		if (pr.appPRNumber && pr.appPRAuthor) {
			if (!pr.codeMerged) continue
			if (!REMINDER_ELIGIBLE_CATEGORIES.has(pr.category)) continue
			// Approved, with nothing tagging the code author since — the docs
			// PR is essentially ready, nothing left to ask them for. If a tag
			// *did* land after the approval, hasOutstandingDocsPing keeps it
			// in (via the "respond" mark) instead of excluding it here.
			if (pr.lastApprovalDate && !hasOutstandingDocsPing(pr)) continue
			remindLogin = pr.appPRAuthor
			mark = reminderMark(pr)
		} else {
			// The standalone-PR clock (see main()) can carry a docs PR through
			// blocked-no-code-pr into needs-followup/needs-escalate-core-team
			// too, purely from your review going unanswered — no tag required.
			// This page's own bar stays higher regardless (see
			// hasOutstandingDocsAuthorPing below): only include it once
			// someone's actually tagged the author, same as before.
			if (
				!["blocked-no-code-pr", "needs-followup", "needs-escalate-core-team"].includes(
					pr.category,
				)
			)
				continue
			if (!hasOutstandingDocsAuthorPing(pr)) continue
			remindLogin = pr.docsAuthor
			mark = {
				kind: "respond",
				who: pr.docsAuthorPingActor,
				sortDate: pr.docsAuthorPingDate,
			}
		}
		if (!remindLogin || BOTS.includes(remindLogin)) continue

		if (!groups.has(remindLogin)) groups.set(remindLogin, [])
		groups.get(remindLogin).push({ pr, mark })
	}
	return [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((author) => {
		const items = groups.get(author).sort((a, b) => {
			const da = a.mark.sortDate ? a.mark.sortDate.getTime() : 0
			const db = b.mark.sortDate ? b.mark.sortDate.getTime() : 0
			return da - db
		})
		return { author, items }
	})
}

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

	// The band mixes two different kinds of "waiting" — keep this text
	// honest about which one is actually driving the count, since the two
	// mean different things (no clock yet vs. a clock counting down).
	const authorWaiting = waiting.filter((p) => p.category === "waiting-code-author-response")
	const mergeWaiting = waiting.filter((p) => p.category === "waiting-code-pr-merge")
	let waitingSub
	if (authorWaiting.length > 0) {
		const minDays = Math.min(
			...authorWaiting.map((p) => FOLLOWUP_DAYS - p.daysSincePing),
		)
		if (minDays <= 0) waitingSub = "next follow-up due today"
		else if (minDays === 1) waitingSub = "next follow-up due tomorrow"
		else waitingSub = `next follow-up due in ${minDays} days`
	} else if (mergeWaiting.length > 0) {
		waitingSub = "waiting for code PRs to merge"
	} else {
		waitingSub = "you've done your part"
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
		["stale", "🕸 Stale"],
	]
	const sevCounts = { critical: 0, serious: 0, act: 0, triage: 0 }
	for (const p of needToday) {
		const s = severityFor(p)
		if (sevCounts[s] != null) sevCounts[s]++
	}
	// Unlike the severity tabs (Need-today only), Stale spans every band —
	// that's the point, it's meant to catch things Waiting/Monitoring would
	// otherwise quietly hide.
	sevCounts.stale = prData.filter((p) => p.staleFlag).length

	const repoTabs = [
		`<button class="ftab active" data-f="repo" data-v="all" aria-pressed="true">All <span class="fc">${prData.length}</span></button>`,
		...repoList.map(
			(r) =>
				`<button class="ftab" data-f="repo" data-v="${escapeHtml(r)}" aria-pressed="false">${escapeHtml(r)} <span class="fc">${repoCounts[r]}</span></button>`,
		),
	].join("")
	const priorityTabs = [
		`<button class="ftab active" data-f="pri" data-v="all" aria-pressed="true">All <span class="fc">${needToday.length}</span></button>`,
		...PRIORITY_TABS.map(
			([v, label]) =>
				`<button class="ftab" data-f="pri" data-v="${v}" aria-pressed="false">${label} <span class="fc">${sevCounts[v]}</span></button>`,
		),
	].join("")
	const filterBar = `
  <div class="filters">
    <div class="fbar" role="group" aria-label="Filter by repo"><span class="fbar-label">Repo</span>${repoTabs}</div>
    <div class="fbar" role="group" aria-label="Filter by priority"><span class="fbar-label">Priority</span>${priorityTabs}</div>
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
      <h2>Waiting on others or for code PR to merge</h2><span class="count">${waiting.length}</span>
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
    /* ink-3 and accent are darkened from their original #898781/#2a78d6 to
       clear 4.5:1 body-text contrast against --page/--surface (WCAG AA) —
       both were ~3.4-4.3:1, since neither was originally picked with small
       running text in mind. */
    --ink-3:#6e6c67;
    --line:#e1e0d9;
    --ring:rgba(11,11,11,.10);
    --critical:#d03b3b;
    --serious:#ec835a;
    --warning:#fab219;
    --good:#0ca30c;
    --good-ink:#006300;
    --accent:#266cc1;
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
    --ink-3:#6e6c67; --line:#e1e0d9; --ring:rgba(11,11,11,.10);
    --good-ink:#006300; --accent:#266cc1; --shadow:0 1px 2px rgba(11,11,11,.05);
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
  .nav-link{
    border:1px solid var(--ring);background:var(--surface);color:var(--ink-2);
    border-radius:6px;padding:4px 10px;font-size:12px;text-decoration:none;
  }
  .nav-link:hover{text-decoration:none;border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}

  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .tile{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    padding:14px 16px;box-shadow:var(--shadow);
    cursor:pointer;font:inherit;text-align:left;color:inherit;
    transition:border-color .15s,transform .1s;
  }
  .tile:hover{border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}
  .tile:active{transform:scale(.99)}
  .tile:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .tile .num{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
  .tile .lbl{font-size:13px;font-weight:600;margin-top:2px}
  .tile .sub{font-size:12px;color:var(--ink-3);margin-top:2px}
  .tile.focus{border-top:3px solid var(--accent)}
  .tile.focus .num{color:var(--accent)}

  .back-to-top{
    position:fixed;bottom:22px;right:22px;z-index:20;
    width:42px;height:42px;border-radius:50%;
    background:var(--surface);border:1px solid var(--ring);box-shadow:var(--shadow);
    color:var(--ink-2);font-size:16px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    opacity:0;visibility:hidden;transform:translateY(8px);
    transition:opacity .15s,transform .15s,visibility .15s,border-color .15s;
  }
  .back-to-top.show{opacity:1;visibility:visible;transform:translateY(0)}
  .back-to-top:hover{border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}

  .sr-only{
    position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0,0,0,0);white-space:nowrap;border:0;
  }
  .skip-link{
    position:absolute;top:-40px;left:8px;z-index:100;
    background:var(--surface);color:var(--ink);border:1px solid var(--ring);
    border-radius:6px;padding:8px 14px;font-size:13px;text-decoration:none;
    transition:top .15s;
  }
  .skip-link:focus{top:8px}

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
  .legend-h{
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
  /* Stale overrides whatever severity color would otherwise show - it's a
     different kind of signal ("gone quiet") than urgency. */
  .row[data-stale="1"]      .edge{background:var(--warning)}

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
  .chip.stale{
    background:color-mix(in srgb, var(--warning) 10%, var(--surface));
    color:color-mix(in srgb, var(--warning) 55%, var(--ink));
    border-color:color-mix(in srgb, var(--warning) 35%, transparent);
    border-style:dashed;
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
  /* Stale spans every band, so picking it shouldn't hide Waiting/Monitoring
     the way the severity tabs do — those are Need-today-only concepts. */
  body:not([data-fpri="all"]):not([data-fpri="stale"]) .band-secondary{display:none}

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

  @media (prefers-reduced-motion: reduce){
    *{animation-duration:.01ms !important;animation-iteration-count:1 !important;
      transition-duration:.01ms !important;scroll-behavior:auto !important}
  }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<div class="wrap">

  <div class="top">
    <h1>Docs PR Tracker</h1>
    <span class="updated">Updated ${formatUpdated(now)}</span>
    <a class="nav-link" href="tracker-reminders.html">📋 Author reminders</a>
    <button class="theme-btn" onclick="toggleTheme()">◐ Theme</button>
  </div>

  <main id="main-content">
  <div class="stats">
    <button class="tile focus" data-goto="today" type="button">
      <div class="num">${needToday.length}</div>
      <div><div class="lbl">Need you today</div>
      <div class="sub">${needTodaySub}</div></div>
    </button>
    <button class="tile" data-goto="waiting" type="button">
      <div class="num">${waiting.length}</div>
      <div><div class="lbl">Waiting on others or for code PR to merge</div>
      <div class="sub">${waitingSub}</div></div>
    </button>
    <button class="tile" data-goto="monitoring" type="button">
      <div class="num">${monitoring.length}</div>
      <div><div class="lbl">Monitoring</div>
      <div class="sub">already handled — nothing to do</div></div>
    </button>
  </div>
${filterBar}
  <details class="legend">
    <summary><span class="tw">▶</span> New here? How to read this board</summary>
    <div class="legend-body">

      <section>
        <h2 class="legend-h">The three bands — whose turn is it?</h2>
        <table>
          <tr><td><b>Need you today</b></td><td>Actions only you can take.</td></tr>
          <tr><td><b>Waiting on others or for code PR to merge</b></td><td>You've done your part — either the code PR still needs to merge (no clock yet), or a reminder's out and the clock is running.</td></tr>
          <tr><td><b>Monitoring</b></td><td>The author replied and you've already looked. Collapsed by default — has its own quiet-conversation clock, and resurfaces if it goes quiet for a week.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">Reading a row</h2>
        <table>
          <tr><td><span class="edge-sample"></span> Left edge</td><td>Urgency at a glance: red overdue → orange due soon → blue actionable → grey triage.</td></tr>
          <tr><td><span class="pill open">Open</span></td><td>A <b>pill</b> — a fact about the PR: Draft / Open / Merged / Closed.</td></tr>
          <tr><td><span class="chip act">Review this docs PR</span></td><td>A <b>chip</b> — an action for you. Colour = task family (below).</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">Colour key — same kind of task, same colour</h2>
        <table>
          <tr><td><span class="chip setup">Setup &amp; triage</span></td><td>Add milestone (every new PR) · Add ${PENDING_LABEL} label (drafts) · Add ${BACKPORT_LABEL} label (older branch)</td></tr>
          <tr><td><span class="chip nudge1">Remind</span> <span class="chip nudge2">Follow up</span> <span class="chip nudge3">Escalate</span></td><td>The nudge ladder — one hue, hotter = more urgent.</td></tr>
          <tr><td><span class="chip act">Review / respond</span></td><td>Review this docs PR · Check the author's response.</td></tr>
          <tr><td><span class="chip finish">Finish &amp; merge</span></td><td>Final review, then merge · Remove ${PENDING_LABEL} label.</td></tr>
          <tr><td><span class="chip backport">Backport first</span></td><td>Must be backported before it can merge.</td></tr>
          <tr><td><span class="chip manual">Manual attention</span></td><td>No code PR linked · someone's waiting on a reply · docs PR needs a rebase.</td></tr>
          <tr><td><span class="chip muted">Optional / already done</span></td><td>Review while the code PR's still open · a reminder you already sent.</td></tr>
          <tr><td><span class="chip dismiss">Close / dismiss</span></td><td>Close this docs PR — its code PR was abandoned.</td></tr>
          <tr><td><span class="chip stale">🕸 Stale</span></td><td>No activity on either PR for 30+ days — purely informational, no clock of its own.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">The escalation clock</h2>
        <p class="legend-note">Only a comment that <b>@-tags the code author</b> starts this clock — yours or a teammate's, but not a plain reply — and it stops the instant the author replies.</p>
        <table>
          <tr><td>Day 0</td><td>Code PR merges, someone @-tags the code author.</td></tr>
          <tr><td>Day ${FOLLOWUP_DAYS}</td><td>Row asks for a follow-up.</td></tr>
          <tr><td>Day ${ESCALATE_DAYS}</td><td>Row asks you to escalate to the core team.</td></tr>
          <tr><td>Any day</td><td>Author replies → clock stops, row asks you to check their response.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">Good to know</h2>
        <table>
          <tr><td>👀 Live threads</td><td>An unanswered human comment on the docs PR. Orange if someone's waiting on <b>you</b>; also shown live if a non-operator is waiting on the <b>code author</b> — checked on its own, so a later unrelated reply to someone else can't hide it. Otherwise it's just visibility, no clock. Includes Promptless when it tags a reviewer outside your team for feedback.</td></tr>
          <tr><td>Approvals</td><td>"approved by …" is shown as a fact everywhere. The "Final review, then merge" action only appears once the code PR has merged.</td></tr>
          <tr><td>Review vs. the clock</td><td>The remind/follow-up/escalate clock no longer waits on you having formally reviewed the docs PR — it only needs the code PR merged. If review's still outstanding, a separate "Review this docs PR — code PR merged" chip rides alongside whatever the clock shows.</td></tr>
          <tr><td>Filtering</td><td>The tabs above filter by <b>repo</b> and <b>priority</b>. Priority counts follow whichever repo is selected.</td></tr>
          <tr><td>Labels</td><td><code>${PENDING_LABEL}</code> — removed once the code PR merges. <code>${BACKPORT_LABEL}</code> — added when a PR targets an older branch than the latest. <code>${NEEDS_REBASE_LABEL}</code> — surfaced as-is, no clock.</td></tr>
        </table>
      </section>

    </div>
  </details>
${needTodaySection}
${waitingSection}
${monitoringSection}
  </main>
  <footer>Generated by <code>node tracker.js</code> as <code>${escapeHtml(operatorUsername)}</code> · ${formatUpdated(now)}</footer>
</div>

<button class="back-to-top" id="backToTop" type="button" aria-label="Back to top" title="Back to top">↑</button>

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
    // A specific severity priority is meaningful only in "Need you today";
    // the CSS hides the Waiting/Monitoring bands whenever pri is a severity.
    // "stale" is different — it spans every band, so it filters rows within
    // each band instead of hiding whole bands.
    document.querySelectorAll('.row').forEach(function(row){
      const okRepo = repo === 'all' || row.getAttribute('data-repo') === repo;
      const okPri  = pri === 'all' ||
        (pri === 'stale' ? row.getAttribute('data-stale') === '1' : row.getAttribute('data-sev') === pri);
      row.classList.toggle('hidden', !(okRepo && okPri));
    });
    document.querySelectorAll('.mon-row').forEach(function(row){
      const okRepo = repo === 'all' || row.getAttribute('data-repo') === repo;
      const okPri = pri === 'all' || (pri === 'stale' && row.getAttribute('data-stale') === '1');
      row.classList.toggle('hidden', !(okRepo && okPri));
    });
    // Recompute per-section visible counts and empty states.
    document.querySelectorAll('section[data-band]').forEach(function(sec){
      const rows = sec.querySelectorAll('.row, .mon-row');
      let vis = 0;
      rows.forEach(function(r){ if(!r.classList.contains('hidden')) vis++; });
      const badge = sec.querySelector('.sec-head .count');
      if (badge) badge.textContent = vis;
      const hiddenByBand = sec.classList.contains('band-secondary') && pri !== 'all' && pri !== 'stale';
      sec.classList.toggle('all-hidden', vis === 0 && !hiddenByBand);
    });
    // Priority tab counts follow the repo selection — "3 triage" should mean
    // 3 in the repo you're looking at, not 3 across everything. These counts
    // ignore the *priority* filter itself (each tab shows what it would find
    // if you picked it next). Severity counts are Need-today only; Stale
    // counts across every band, to match what picking it actually reveals.
    const todayRows = document.querySelectorAll('section[data-band="today"] .row');
    const bySev = { critical: 0, serious: 0, act: 0, triage: 0 };
    let repoTotal = 0;
    todayRows.forEach(function(row){
      if (repo !== 'all' && row.getAttribute('data-repo') !== repo) return;
      repoTotal++;
      const sev = row.getAttribute('data-sev');
      if (bySev[sev] != null) bySev[sev]++;
    });
    let staleTotal = 0;
    document.querySelectorAll('.row, .mon-row').forEach(function(row){
      if (repo !== 'all' && row.getAttribute('data-repo') !== repo) return;
      if (row.getAttribute('data-stale') === '1') staleTotal++;
    });
    document.querySelectorAll('.ftab[data-f="pri"]').forEach(function(tab){
      const fc = tab.querySelector('.fc');
      if (!fc) return;
      const v = tab.getAttribute('data-v');
      if (v === 'all') fc.textContent = repoTotal;
      else if (v === 'stale') fc.textContent = staleTotal;
      else fc.textContent = bySev[v] || 0;
    });
  }

  document.querySelectorAll('.ftab').forEach(function(tab){
    tab.addEventListener('click', function(){
      const dim = tab.getAttribute('data-f');   // 'repo' | 'pri'
      const val = tab.getAttribute('data-v');
      filterState[dim] = val;
      document.body.setAttribute(dim === 'repo' ? 'data-frepo' : 'data-fpri', val);
      tab.parentElement.querySelectorAll('.ftab').forEach(function(t){
        const isActive = t === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      applyFilters();
    });
  });

  // ---- summary tiles: jump to section ----
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = reduceMotion ? 'auto' : 'smooth';
  document.querySelectorAll('.tile[data-goto]').forEach(function(tile){
    tile.addEventListener('click', function(){
      const sec = document.querySelector('section[data-band="' + tile.getAttribute('data-goto') + '"]');
      if (!sec) return;
      // Monitoring is collapsed by default - open it so scrolling there
      // actually shows something instead of landing on a closed summary.
      const details = sec.querySelector('details');
      if (details) details.open = true;
      sec.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    });
  });

  // ---- back to top ----
  const backToTop = document.getElementById('backToTop');
  if (backToTop) {
    window.addEventListener('scroll', function(){
      backToTop.classList.toggle('show', window.scrollY > 400);
    }, { passive: true });
    backToTop.addEventListener('click', function(){
      window.scrollTo({ top: 0, behavior: scrollBehavior });
      backToTop.blur();
      document.querySelector('h1').setAttribute('tabindex', '-1');
      document.querySelector('h1').focus();
    });
  }
</script>
</body>
</html>`

	fs.writeFileSync("tracker-report.html", html)
}

function renderAuthorGroup(group) {
	const anchor = group.author.toLowerCase()
	const rows = group.items
		.map(({ pr, mark }) => {
			const key = cacheKey(pr.sourceRepo, pr.number)
			const markHtml =
				mark.kind === "review"
					? `<span class="mark review">Need review</span>`
					: `<span class="mark respond">Response to comment from ${escapeHtml(mark.who)}</span>`
			const codePRHtml = pr.appPRNumber
				? `<a href="${pr.appPRUrl}" target="_blank">mautic/mautic #${pr.appPRNumber}</a>`
				: `<span class="none">No linked code PR</span>`
			const rowLabel = `${pr.repoShort} #${pr.number}: ${pr.title}`
			return `
        <tr data-key="${escapeHtml(key)}">
          <td class="chk"><input type="checkbox" aria-label="Mark ${escapeHtml(rowLabel)} as done"></td>
          <td><a href="${pr.url}" target="_blank">${escapeHtml(pr.repoShort)} #${pr.number}</a> ${escapeHtml(pr.title)}</td>
          <td>${codePRHtml}</td>
          <td>${markHtml}</td>
        </tr>`
		})
		.join("")
	return `
  <section class="author-group" id="author-${escapeHtml(anchor)}">
    <div class="author-head">
      <h2><a href="https://github.com/${escapeHtml(group.author)}" target="_blank">@${escapeHtml(group.author)}</a></h2>
      <span class="author-progress">0/${group.items.length} checked</span>
    </div>
    <table>
      <thead><tr><th scope="col"><span class="sr-only">Done</span></th><th scope="col">Docs PR</th><th scope="col">Code PR</th><th scope="col">Mark</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

// A separate, self-contained page (mirrors generateHTML's structure but not
// its markup) meant to be shared directly with code PR authors — a plain
// per-person checklist of docs PRs waiting on them, with no internal
// severity/escalation framing.
function generateReminderHTML(groups, { now }) {
	const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0)
	const tocHtml =
		groups.length > 1
			? `
  <div class="toc">${groups
		.map(
			(g) =>
				`<a href="#author-${escapeHtml(g.author.toLowerCase())}">@${escapeHtml(g.author)} <span class="tc">${g.items.length}</span></a>`,
		)
		.join("")}</div>`
			: ""
	const bodyHtml =
		groups.length === 0
			? `<div class="empty">Nothing to remind anyone about right now — every merged code PR's docs are either reviewed or actively being discussed. 🎉</div>`
			: groups.map(renderAuthorGroup).join("")

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docs PR Review Reminders</title>
<style>
  :root{
    --page:#f9f9f7;
    --surface:#fcfcfb;
    --ink:#0b0b0b;
    --ink-2:#52514e;
    /* Darkened from #898781/#2a78d6 for 4.5:1 body-text contrast (WCAG AA)
       against --page/--surface — see the same note in the dashboard. */
    --ink-3:#6e6c67;
    --line:#e1e0d9;
    --ring:rgba(11,11,11,.10);
    --accent:#266cc1;
    --shadow:0 1px 2px rgba(11,11,11,.05);
    --manual:#c2255c;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7;
      --ink-3:#898781; --line:#2c2c2a; --ring:rgba(255,255,255,.10);
      --accent:#3987e5; --shadow:none; --manual:#e57e9f;
    }
  }
  :root[data-theme="dark"]{
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7;
    --ink-3:#898781; --line:#2c2c2a; --ring:rgba(255,255,255,.10);
    --accent:#3987e5; --shadow:none; --manual:#e57e9f;
  }
  :root[data-theme="light"]{
    --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e;
    --ink-3:#6e6c67; --line:#e1e0d9; --ring:rgba(11,11,11,.10);
    --accent:#266cc1; --shadow:0 1px 2px rgba(11,11,11,.05); --manual:#c2255c;
  }

  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    background:var(--page); color:var(--ink);
    font-size:14px; line-height:1.45;
    padding:24px 16px 48px;
  }
  .wrap{max-width:820px;margin:0 auto}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  b{font-weight:600}

  .top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
  .updated{color:var(--ink-3);font-size:12px;margin-right:auto}
  .theme-btn{
    border:1px solid var(--ring);background:var(--surface);color:var(--ink-2);
    border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;
  }
  .nav-link{
    border:1px solid var(--ring);background:var(--surface);color:var(--ink-2);
    border-radius:6px;padding:4px 10px;font-size:12px;text-decoration:none;
  }
  .nav-link:hover{text-decoration:none;border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}

  .intro{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    padding:14px 16px;margin:16px 0 24px;font-size:13px;color:var(--ink-2);box-shadow:var(--shadow);
  }
  .intro b{color:var(--ink)}

  .toc{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:24px}
  .toc a{
    display:inline-flex;align-items:center;gap:5px;
    border:1px solid var(--ring);background:var(--surface);border-radius:999px;
    padding:3px 10px 3px 12px;font-size:12px;color:var(--ink-2);text-decoration:none;
  }
  .toc a:hover{border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}
  .toc .tc{
    background:color-mix(in srgb, var(--ink) 8%, var(--surface));border-radius:999px;
    padding:0 6px;font-weight:600;color:var(--ink-2);
  }

  .author-group{margin-bottom:28px}
  .author-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
  .author-head h2{font-size:16px;font-weight:650}
  .author-progress{font-size:12px;color:var(--ink-3)}

  table{
    width:100%;border-collapse:collapse;background:var(--surface);
    border:1px solid var(--ring);border-radius:10px;overflow:hidden;box-shadow:var(--shadow);
  }
  th,td{padding:8px 12px;text-align:left;font-size:13px;border-top:1px solid var(--line)}
  th{
    background:color-mix(in srgb, var(--ink) 3%, var(--surface));font-size:11px;
    text-transform:uppercase;letter-spacing:.03em;color:var(--ink-3);font-weight:600;border-top:none;
  }
  tbody tr:first-child td{border-top:none}
  td.chk{width:36px;text-align:center}
  tr.checked td{color:var(--ink-3);text-decoration:line-through}
  tr.checked td.chk{text-decoration:none}
  input[type=checkbox]{width:16px;height:16px;cursor:pointer}
  input[type=checkbox]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  .sr-only{
    position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0,0,0,0);white-space:nowrap;border:0;
  }
  .skip-link{
    position:absolute;top:-40px;left:8px;z-index:100;
    background:var(--surface);color:var(--ink);border:1px solid var(--ring);
    border-radius:6px;padding:8px 14px;font-size:13px;text-decoration:none;
    transition:top .15s;
  }
  .skip-link:focus{top:8px}

  .mark{display:inline-flex;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;white-space:nowrap}
  .mark.review{
    background:color-mix(in srgb, var(--accent) 11%, var(--surface));
    color:color-mix(in srgb, var(--accent) 78%, var(--ink));
  }
  .mark.respond{
    background:color-mix(in srgb, var(--manual) 10%, var(--surface));
    color:color-mix(in srgb, var(--manual) 72%, var(--ink));
  }
  .none{color:var(--ink-3)}

  .empty{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    padding:40px 24px;text-align:center;box-shadow:var(--shadow);color:var(--ink-2);
  }

  .back-to-top{
    position:fixed;bottom:22px;right:22px;z-index:20;
    width:42px;height:42px;border-radius:50%;
    background:var(--surface);border:1px solid var(--ring);box-shadow:var(--shadow);
    color:var(--ink-2);font-size:16px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    opacity:0;visibility:hidden;transform:translateY(8px);
    transition:opacity .15s,transform .15s,visibility .15s,border-color .15s;
  }
  .back-to-top.show{opacity:1;visibility:visible;transform:translateY(0)}
  .back-to-top:hover{border-color:color-mix(in srgb, var(--accent) 40%, var(--ring))}

  footer{margin-top:32px;font-size:12px;color:var(--ink-3);text-align:center}

  @media (max-width:640px){
    th:nth-child(3),td:nth-child(3){display:none}
  }

  @media (prefers-reduced-motion: reduce){
    *{animation-duration:.01ms !important;animation-iteration-count:1 !important;
      transition-duration:.01ms !important;scroll-behavior:auto !important}
  }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<div class="wrap">

  <div class="top">
    <h1>Docs PR Review Reminders</h1>
    <span class="updated">Updated ${formatUpdated(now)}</span>
    <a class="nav-link" href="tracker-report.html">← Dashboard</a>
    <button class="theme-btn" onclick="toggleTheme()">◐ Theme</button>
  </div>

  <div class="intro">
    Docs PRs waiting on <b>your</b> review or response to a comment, grouped
    by name — either your linked code PR has merged, or it's a docs PR you
    opened yourself that's waiting on your reply. Checking a box only saves
    to <b>your own browser</b>, purely to help you track your own progress —
    it doesn't change anything on our end, so this list keeps reflecting the
    real current state either way, and updates automatically as things get
    resolved.
  </div>
  <main id="main-content">
${tocHtml}
${bodyHtml}
  </main>
  <footer>Generated by <code>node tracker.js</code> · ${formatUpdated(now)} · ${totalItems} PR${totalItems === 1 ? "" : "s"} across ${groups.length} author${groups.length === 1 ? "" : "s"}</footer>
</div>

<button class="back-to-top" id="backToTop" type="button" aria-label="Back to top" title="Back to top">↑</button>

<script>
  function toggleTheme(){
    const r = document.documentElement;
    const cur = r.getAttribute('data-theme');
    r.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  }

  // ---- checklist (saved to this browser only, via localStorage) ----
  (function(){
    var STORE_KEY = 'docsReminderChecklist';
    var state = {};
    try { state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { state = {}; }

    function updateProgress(group){
      if (!group) return;
      var total = group.querySelectorAll('tr[data-key]').length;
      var done = group.querySelectorAll('tr[data-key].checked').length;
      var badge = group.querySelector('.author-progress');
      if (badge) badge.textContent = done + '/' + total + ' checked';
    }

    var validKeys = {};
    document.querySelectorAll('tr[data-key]').forEach(function(row){
      var key = row.getAttribute('data-key');
      validKeys[key] = true;
      var cb = row.querySelector('input[type=checkbox]');
      if (state[key]) { cb.checked = true; row.classList.add('checked'); }
      cb.addEventListener('change', function(){
        if (cb.checked) state[key] = true; else delete state[key];
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
        row.classList.toggle('checked', cb.checked);
        updateProgress(row.closest('.author-group'));
      });
    });
    // Drop saved keys for items no longer listed (already resolved) so
    // localStorage doesn't grow forever with stale entries.
    var changed = false;
    Object.keys(state).forEach(function(k){
      if (!validKeys[k]) { delete state[k]; changed = true; }
    });
    if (changed) localStorage.setItem(STORE_KEY, JSON.stringify(state));

    document.querySelectorAll('.author-group').forEach(updateProgress);
  })();

  // ---- back to top ----
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const backToTop = document.getElementById('backToTop');
  if (backToTop) {
    window.addEventListener('scroll', function(){
      backToTop.classList.toggle('show', window.scrollY > 400);
    }, { passive: true });
    backToTop.addEventListener('click', function(){
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      document.querySelector('h1').setAttribute('tabindex', '-1');
      document.querySelector('h1').focus();
    });
  }
</script>
</body>
</html>`

	fs.writeFileSync("tracker-reminders.html", html)
}

module.exports = { main }

if (require.main === module) {
	main().catch((err) => {
		console.error("❌ Error:", err.message)
		process.exit(1)
	})
}
