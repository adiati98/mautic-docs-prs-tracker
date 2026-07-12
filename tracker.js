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
const CONTENT_APPROVED_LABEL =
	process.env.CONTENT_APPROVED_LABEL || "content-approved"
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

// GitHub caps every list endpoint at 100 items per page regardless of what
// (if anything) the caller passes as per_page — silently, with no error and
// no indication in the response that more pages exist beyond the Link
// header. A PR that crosses that boundary would have its *oldest* items
// returned (comments/reviews) or an arbitrary subset (branches), so without
// this, activity past page 1 just vanishes from every derivation that reads
// it. Loops until a short page confirms there's nothing left.
async function fetchAllPages(baseUrl) {
	const results = []
	let page = 1
	for (;;) {
		const sep = baseUrl.includes("?") ? "&" : "?"
		const batch = await makeRequest(`${baseUrl}${sep}per_page=100&page=${page}`)
		results.push(...batch)
		if (batch.length < 100) break
		page++
	}
	return results
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
		return await fetchAllPages(`https://api.github.com/repos/${repo}/pulls?state=open`)
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
		return await fetchAllPages(
			`https://api.github.com/repos/${repo}/pulls/${number}/reviews`,
		)
	} catch (e) {
		console.error(`Error fetching reviews for ${repo}#${number}:`, e.message)
		return null
	}
}

async function fetchIssueComments(repo, number) {
	try {
		return await fetchAllPages(
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
			milestoneTitle: pr.milestone ? pr.milestone.title : null,
			baseBranch: pr.base.ref,
		}
	} catch (e) {
		console.error(`Error fetching code PR ${repo}#${number}:`, e.message)
		return {
			merged: false,
			mergedAt: null,
			state: "open",
			author: null,
			updatedAt: null,
			milestoneTitle: null,
			baseBranch: null,
		}
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
	return {
		user: { login: r.user.login },
		state: r.state,
		submitted_at: r.submitted_at,
		body: r.body,
	}
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
		const branches = await fetchAllPages(`https://api.github.com/repos/${repo}/branches`)
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

// Promptless opens one sibling PR per release branch by design, each titled
// with the branch it targets (e.g. "... (7.0)" against base branch "7.0").
// That per-branch PR *is* the backport — there's no separate porting step
// left to do, so asking for needs-backport on top of it would be redundant.
function isPurposeBuiltForBranch(title, baseBranch, authorLogin) {
	return authorLogin === PROMPTLESS && milestoneVersion(title) === baseBranch
}

function tryExtractAppPR(text) {
	let match = text.match(/mautic\/([a-z0-9-]+)\s*(?:PR\s*)?#(\d+)/i)
	if (match) return { repo: `mautic/${match[1]}`, number: match[2] }

	match = text.match(/mautic\s+PR\s*#(\d+)/i)
	if (match) return { repo: "mautic/mautic", number: match[1] }

	match = text.match(/\[PR\s*#(\d+)\]/i)
	if (match) return { repo: "mautic/mautic", number: match[1] }

	return null
}

// Extract app PR info from description (supports any mautic/* repo). Takes
// the first match in the body.
//
// A "prefer a recognized heading (Promptless's 'Trigger Events', this repo's
// 'Linked issue' template section) over a plain first-match scan" version of
// this was tried and reverted: on mautic/user-documentation#774, the
// "Trigger Events" PR (mautic/api-library#348, a validation tweak) was a
// different, less-relevant PR than the one actually mentioned first in the
// prose (mautic/mautic#15404, the real feature PR) — humans in the thread
// confirmed the first-mentioned one was the one that mattered for review
// purposes. So "first PR number mentioned" is closer to this project's real
// convention than "whatever's under this particular heading," at least
// until there's positive evidence otherwise.
function extractAppPR(description) {
	if (!description) return null
	return tryExtractAppPR(description)
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

// §4 — operator's own docs-PR review done. Also names whichever operator got
// there first — in team mode, that's what tells a second maintainer someone
// already looked, instead of them finding out only by the review chip's
// absence (see reviewInProgressChip).
function computeOperatorReviewDate(docsReviews, docsComments, operatorLogins) {
	const events = [
		...docsReviews
			.filter(
				(r) =>
					operatorLogins.has(r.user.login.toLowerCase()) &&
					["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(r.state),
			)
			.map((r) => ({ date: new Date(r.submitted_at), actor: r.user.login })),
		...docsComments
			.filter((c) => operatorLogins.has(c.user.login.toLowerCase()))
			.map((c) => ({ date: new Date(c.created_at), actor: c.user.login })),
	]
	const earliest = events.reduce(
		(best, e) => (!best || e.date < best.date ? e : best),
		null,
	)
	return { date: earliest ? earliest.date : null, actor: earliest ? earliest.actor : null }
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
				(c) =>
					c.user.login !== appPRAuthor &&
					(operatorLogins.has(c.user.login.toLowerCase()) || c.user.login === PROMPTLESS) &&
					mentions(c.body, appPRAuthor),
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
function computeCommunityThread({
	rawDocsComments,
	rawDocsReviews,
	operatorLogins,
	appPRAuthor,
	lastOperatorApprovalDate,
}) {
	const none = { lit: false }
	// Once an operator approves, whatever was said before that is settled
	// business — only what's happened *since* is still live. Without this, an
	// old tag from before the approval keeps reading as an outstanding thread
	// even after the approval has moved things on. Scoped to an operator's
	// own approval specifically — a non-operator approval (the code author, a
	// community reviewer) doesn't carry the same "someone with authority
	// looked at the whole thread" weight, so it shouldn't get to silently
	// erase someone else's still-unanswered question.
	let comments = rawDocsComments.filter((c) => !IGNORED_BOTS.includes(c.user.login))
	let reviews = rawDocsReviews.filter((r) => !IGNORED_BOTS.includes(r.user.login))
	if (lastOperatorApprovalDate) {
		comments = comments.filter((c) => new Date(c.created_at) > lastOperatorApprovalDate)
		reviews = reviews.filter((r) => new Date(r.submitted_at) > lastOperatorApprovalDate)
	}
	if (comments.length === 0) return none

	// Independent check: the most recent tag of the code PR author on the
	// docs PR, and whether they've replied since — checked on its own, not
	// gated by whatever the single latest comment overall happens to be
	// about. A later, unrelated exchange with someone else (e.g. Promptless
	// replying to you) shouldn't hide an author-directed tag that's still
	// sitting unanswered. An operator's own tag used to be excluded here on
	// the assumption the escalation clock's metaLine text always names them
	// instead — but that text only names the pinger when they're *not* an
	// operator (see metaLine's needs-followup/needs-escalate-core-team/
	// waiting-code-author-response cases); for an operator ping it goes
	// generic ("reminder sent, waiting for a reply") and never says who, so
	// excluding it here just made the tag disappear entirely instead of
	// being covered elsewhere. remindedOpenChip below handles not double-
	// narrating the non-operator case.
	if (appPRAuthor) {
		const authorTags = comments.filter(
			(c) => c.user.login !== appPRAuthor && mentions(c.body, appPRAuthor),
		)
		const lastAuthorTag = authorTags.reduce(
			(best, c) => (!best || new Date(c.created_at) > new Date(best.created_at) ? c : best),
			null,
		)
		if (lastAuthorTag) {
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
					commenterIsOperator: operatorLogins.has(lastAuthorTag.user.login.toLowerCase()),
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
	let processingFailures = 0

	const prData = []
	for (let i = 0; i < allPRs.length; i++) {
		const pr = allPRs[i]
		process.stdout.write(`\r  Processing PR ${i + 1}/${allPRs.length}`)

		// One PR with unexpected data (a malformed milestone, an odd body
		// shape) must not take the whole run down — every other fetch in
		// this loop already fails soft with its own try/catch; this is the
		// same guarantee for the categorization logic itself. A failed PR is
		// simply left out of this run's report rather than losing all of
		// them.
		try {
		const isDraft = pr.draft
		const hasLabel = pr.labels.some((l) => l.name === PENDING_LABEL)
		const hasBackportLabel = pr.labels.some((l) => l.name === BACKPORT_LABEL)
		const hasNeedsRebaseLabel = pr.labels.some((l) => l.name === NEEDS_REBASE_LABEL)
		const hasContentApprovedLabel = pr.labels.some(
			(l) => l.name === CONTENT_APPROVED_LABEL,
		)
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
		let codeMilestoneTitle = null
		let codeBaseBranch = null

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
			codeMilestoneTitle = codePR.milestoneTitle
			codeBaseBranch = codePR.baseBranch
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

		const { date: operatorReviewDate, actor: operatorReviewActor } =
			computeOperatorReviewDate(docsReviews, docsComments, operatorLogins)
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
		// GitHub auto-dismisses an APPROVED review the moment new commits
		// land — even a push that only addresses feedback unrelated to what
		// the approver actually signed off on — and every downstream
		// approval fact (finalReviewActionable, the escalation-clock
		// shortcut, the "Approved by X" chip) disappears along with it. The
		// content-approved label is how an operator manually restores that
		// fact once they've confirmed the dismissal was spurious: a
		// deliberate human call, not something inferred from the API. Login
		// attribution reuses whichever non-author human reviews now show up
		// as DISMISSED — the state GitHub's stale-approval auto-dismissal
		// always leaves behind (a CHANGES_REQUESTED review is never
		// auto-dismissed this way) — so no extra API call is needed to name
		// them.
		const dismissedApproverLogins = [
			...new Set(
				docsReviews
					.filter((r) => r.state === "DISMISSED" && r.user.login !== pr.user.login)
					.map((r) => r.user.login),
			),
		]
		const contentApprovedByLabel =
			hasContentApprovedLabel && dismissedApproverLogins.length > 0
		const approvedByNonOperator = nonOperatorApprovals.length > 0 || contentApprovedByLabel
		// Any unrevoked approval that isn't the PR author approving their own
		// work — GitHub blocks self-approval for everyone except one admin
		// exception, so in practice this exclusion only ever catches that one
		// case. Broader than nonOperatorApprovals above: this is what lets an
		// *operator's* approval count too, which matters for the standalone-PR
		// "ready" logic below (nonOperatorApprovals stays as-is for the
		// linked-PR flows that already relied on excluding operators).
		const qualifyingApprovals = docsReviews.filter(
			(r) => r.state === "APPROVED" && r.user.login !== pr.user.login,
		)
		const hasQualifyingApproval = qualifyingApprovals.length > 0 || contentApprovedByLabel
		const operatorApproved = qualifyingApprovals.some((r) =>
			operatorLogins.has(r.user.login.toLowerCase()),
		)
		// Unique approver logins in order — shown as a fact ("Approved by X")
		// in any band, regardless of category. Deliberately live-only (unlike
		// hasQualifyingApproval above): a label-preserved approval gets its
		// own, differently-worded chip (see approvalChips) so the row is
		// honest about GitHub no longer showing this as a formal approval.
		const approverLogins = [...new Set(qualifyingApprovals.map((r) => r.user.login))]
		// Most recent qualifying approval on the docs PR. Read by the reminder
		// report (buildReminderGroups) to compare against the last ping —
		// whichever happened more recently decides if the approval or an
		// outstanding comment "wins" — and by noteSinceApprovalFlag below, to
		// catch anything that landed after the fact.
		const lastApprovalDate = latestDate(qualifyingApprovals.map((r) => new Date(r.submitted_at)))
		// Same, but scoped to an operator's own approval specifically — used
		// only to gate dropping earlier community-thread comments (see
		// computeCommunityThread). A non-operator approval doesn't carry the
		// same "a maintainer looked at the whole thread and signed off"
		// weight, so it shouldn't get to silently erase someone else's still-
		// unanswered question just because it happened to land first.
		const lastOperatorApprovalDate = latestDate(
			qualifyingApprovals
				.filter((r) => operatorLogins.has(r.user.login.toLowerCase()))
				.map((r) => new Date(r.submitted_at)),
		)
		// The approval itself can carry the caveat — "LGTM but needs a rebase
		// onto 5.x first" written straight into the review body — so trust in
		// the approval shouldn't hinge only on what came after it.
		const lastApproval = qualifyingApprovals.reduce(
			(latest, r) =>
				!latest || new Date(r.submitted_at) > new Date(latest.submitted_at)
					? r
					: latest,
			null,
		)
		const approvalHasNote = Boolean(lastApproval?.body?.trim())
		// A comment or a non-approving review after the latest approval — the
		// approval might not actually be the last word (a late second thought,
		// a rebase/backport note left alongside it), so it's worth a glance
		// rather than trusting the approval blindly.
		const noteSinceApprovalFlag =
			lastApprovalDate !== null &&
			(approvalHasNote ||
				[...docsComments, ...docsReviews].some(
					(e) =>
						e.state !== "APPROVED" &&
						new Date(e.submitted_at || e.created_at) > lastApprovalDate,
				))

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
			lastOperatorApprovalDate,
		})

		// §5a — independent action flags.
		//
		// The final-review action ("do the review, then merge") is only
		// offered once the code PR has merged — while it's still open we don't
		// merge the docs PR, so an approval is surfaced as a *fact* (the
		// "Approved by X" chip) on a waiting row rather than as a merge
		// action. A standalone PR has no code PR to wait on, so any
		// qualifying approval — including the operator's own — is enough;
		// there's no one else left to review it.
		let removeLabelFlag = codeMerged && hasLabel
		let finalReviewActionable = appPRNumber
			? approvedByNonOperator && codeMerged
			: hasQualifyingApproval
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
		let backportLabelFlag =
			olderBranch &&
			!hasBackportLabel &&
			!rebaseWinsOverBackport &&
			!isPurposeBuiltForBranch(pr.title, baseBranch, pr.user.login)
		if (codeClosed) {
			removeLabelFlag = false
			finalReviewActionable = false
			backportLabelFlag = false
			needsRebaseFlag = false
			rebaseWinsOverBackport = false
		}
		const backportModifierActive =
			finalReviewActionable && olderBranch && !rebaseWinsOverBackport
		// The operator's own approval settled a standalone PR — nothing left
		// to review, just merge. Distinct wording from the plain
		// finalReviewActionable case (where a *non*-operator approved and the
		// operator's own look is still the thing that's pending). Backport
		// targeting is a structural concern independent of who approved, so
		// it still wins over this and keeps its own chip.
		const standaloneOperatorReady =
			finalReviewActionable && !appPRNumber && operatorApproved && !backportModifierActive

		// Mautic release branches are always "X.Y" — but a code PR's
		// milestone (the actual source of truth for where a docs PR should
		// eventually land) can be set to a patch/pre-release title like
		// "7.1.1" or "7.1.0-rc" at any point, before or after the code PR
		// merges. milestoneVersion() already normalizes those down to "X.Y".
		// When no milestone is set yet (e.g. Promptless opens the docs PR
		// the moment the code PR lands, before triage), fall back to the
		// code PR's own base branch: a real release branch (e.g. "7.1")
		// names a specific version directly, while a dev-line branch (e.g.
		// "7.x" — doesn't match RELEASE_BRANCH_PATTERN) has no version of
		// its own and means "whatever's next", i.e. the docs repo's current
		// latest release branch, not its default branch.
		//
		// If that disagrees with either the docs PR's current target branch
		// or its own milestone, that's worth an early heads-up — before
		// anyone's manually caught it and applied needs-rebase, which is
		// when this stands down instead of piling on.
		const codeMilestoneBranch = milestoneVersion(codeMilestoneTitle)
		const codeExpectedFromBaseBranch = codeMilestoneBranch === null && codeBaseBranch !== null
		const codeExpectedBranch =
			codeMilestoneBranch !== null
				? codeMilestoneBranch
				: codeBaseBranch === null
					? null
					: RELEASE_BRANCH_PATTERN.test(codeBaseBranch)
						? codeBaseBranch
						: latestReleaseBranch
		const docsMilestoneBranch = milestoneVersion(milestoneTitle)
		const codeMilestoneBranchMismatch =
			codeExpectedBranch !== null && codeExpectedBranch !== baseBranch
		const codeMilestoneDocsMismatch =
			codeExpectedBranch !== null &&
			docsMilestoneBranch !== null &&
			docsMilestoneBranch !== codeExpectedBranch
		const codeMilestoneAdvisoryFlag =
			!codeClosed &&
			!needsRebaseFlag &&
			(codeMilestoneBranchMismatch || codeMilestoneDocsMismatch)

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
			// A qualifying approval — operator or not, since for a standalone
			// PR the operator's own approval is the final review, there's no
			// one else left to wait on — settles it the same way it does the
			// code-author flow, unless it still needs a rebase, since a wrong
			// branch target is worth flagging regardless of content approval.
			if (hasQualifyingApproval && !needsRebaseFlag) {
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
			hasContentApprovedLabel,
			contentApprovedByLabel,
			dismissedApproverLogins,
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
			operatorReviewActor,
			devApproved,
			approvedByNonOperator,
			hasQualifyingApproval,
			operatorApproved,
			approverLogins,
			lastApprovalDate,
			noteSinceApprovalFlag,
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
			standaloneOperatorReady,
			rebaseWinsOverBackport,
			codeBaseBranch,
			codeMilestoneBranch,
			codeExpectedBranch,
			codeExpectedFromBaseBranch,
			docsMilestoneBranch,
			codeMilestoneBranchMismatch,
			codeMilestoneDocsMismatch,
			codeMilestoneAdvisoryFlag,
			daysSinceActivity,
			staleFlag,
			category,
		})
		} catch (err) {
			console.error(
				`\n  ⚠ skipping ${cacheKey(pr.sourceRepo, pr.number)} — processing failed: ${err.message}`,
			)
			processingFailures++
		}
	}

	// Drop entries for docs PRs no longer open (merged/closed) so the cache
	// file doesn't grow forever.
	const liveKeys = new Set(allPRs.map((pr) => cacheKey(pr.sourceRepo, pr.number)))
	for (const key of Object.keys(cache)) {
		if (!liveKeys.has(key)) delete cache[key]
	}
	saveCache(cache)

	const failNote = fetchFailures > 0 ? `, ${fetchFailures} fetch failed (kept prior)` : ""
	const skippedNote =
		processingFailures > 0 ? `, ${processingFailures} skipped (processing failed)` : ""
	console.log(
		`\n✅ Done! 📦 cache: ${cacheHits} reused, ${cacheMisses} fetched${failNote}${skippedNote}\n`,
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
		pr.codeMilestoneAdvisoryFlag ||
		// The code PR merged and nobody's formally reviewed the docs PR yet —
		// without this, a row whose category is otherwise quiet (monitoring,
		// waiting-code-pr-merge) would carry the blue "Review this docs PR —
		// code PR merged" chip while sitting in a band with no severity/edge
		// concept at all (Waiting hardcodes data-sev="none"; Monitoring rows
		// have no edge). This is a real "you need to review it" action item,
		// so it belongs here regardless of what else the category says.
		pr.reviewPendingFlag ||
		communityForcesToday(pr)
	)
}

// Approved and ready, with nothing else going on — every chip on the row
// belongs to the finish/backport family (the "Approved by X" fact plus the
// merge action itself). Anything else present (a rebase flag, a live
// thread, a milestone advisory, a stale badge...) means there's still a
// human judgment call to make, so it doesn't count as "clean" — that row
// stays in Need-today instead (see sortRank), right at the top.
function isCleanApprovedRow(pr) {
	if (!pr.finalReviewActionable) return false
	return chipsFor(pr).every((c) => c.cls === "finish" || c.cls === "backport")
}

// Bring it forward: not urgent, but worth surfacing on your own schedule
// rather than buried in — or missing entirely from — the urgent list. Carved
// out of what would otherwise be Need-today (never out of Waiting or
// Monitoring, which stay as they are): brand-new PRs still needing their
// first label/milestone, approvals that are cleanly ready to merge, and
// anything stale. Stale wins over "clean approved" by construction — a
// stale row's chip list always includes the stale badge, so it can never
// pass the all-finish/backport check above.
function isBringForwardRow(pr) {
	return (
		pr.category === "needs-label-and-milestone" ||
		pr.category === "needs-milestone" ||
		pr.staleFlag ||
		isCleanApprovedRow(pr)
	)
}

// Which of the three Bring-it-forward groups a row belongs to, in the order
// they're listed: new PRs to triage, then clean approvals, then stale.
function bringForwardRank(pr) {
	if (pr.category === "needs-label-and-milestone" || pr.category === "needs-milestone") return 0
	if (pr.staleFlag) return 2
	return 1
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

// Plain-text search index for the quick-search box — lets a maintainer find
// a row by docs or code PR number, title, either author, or any chip text
// (e.g. "escalate", "stale", "rebase") without needing to know which band
// it landed in. Built from raw fields rather than the already-escaped chip
// HTML so it isn't polluted by markup; escaped once, as a whole, when it's
// written into the data-search attribute by the caller.
function searchBlobFor(pr, chips) {
	const parts = [pr.repoShort, `#${pr.number}`, pr.title, pr.docsAuthor]
	if (pr.appPRNumber) parts.push(`#${pr.appPRNumber}`)
	if (pr.appPRAuthor) parts.push(pr.appPRAuthor)
	if (chips && chips.length) parts.push(...chips.map((c) => c.text))
	return parts
		.filter(Boolean)
		.join(" ")
		.toLowerCase()
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
		// New PRs still needing a label/milestone always land in Bring it
		// forward now (see isBringForwardRow), never Need-today — but
		// something genuinely needs doing, so it's "act", not "triage".
		case "needs-label-and-milestone":
		case "needs-milestone":
			return "act"
		case "needs-operator-review":
			// A standalone PR with nothing else gating it renders the blue
			// "act" chip (see chipsFor) since your review is the entire
			// blocker — the edge should match. Stays the muted triage color
			// when a linked code PR is still open and there's no rush yet.
			return !pr.appPRNumber && !pr.isDraft ? "act" : "triage"
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

// Only ever called on rows that already passed !isBringForwardRow, so
// staleFlag, the two triage categories, and a clean approval never reach
// here — they've moved to Bring it forward entirely.
function sortRank(pr) {
	// A finalReviewActionable row still in Need-today is the messy kind —
	// approved and ready, but with something else attached (a rebase flag, a
	// live thread, a milestone advisory...) that keeps it out of Bring it
	// forward's "clean" bucket. It's the closest to done of anything here,
	// so it goes to the very top to push it over the line.
	if (pr.finalReviewActionable) return -1
	if (pr.category === "needs-close-docs-pr") return 0
	if (pr.category === "needs-escalate-core-team") return 2
	if (pr.category === "needs-followup") return 3
	if (pr.community.lit && pr.community.waitingOnKind === "operator") return 3.5
	if (pr.category === "needs-remind-code-author") return 4
	// "You still need to review this" — whether that's because the code PR
	// merged and nobody's looked (reviewPendingFlag) or it's a standalone PR
	// with nothing else gating it (the blue chip case, see categorySeverity)
	// — ranks above the muted/gray needs-operator-review tier it'd otherwise
	// share with linked-but-still-open PRs, which aren't as pressing.
	if (pr.reviewPendingFlag || (pr.category === "needs-operator-review" && !pr.appPRNumber && !pr.isDraft))
		return 6
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

	// Approval is now a chip (see approvalChips) — noticeable there in a way
	// this prose line never was.
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

// A standalone PR (no linked code PR) that's open and not a draft has
// nothing else gating it — your review is the entire blocker, so it reads
// as an actual action (blue), not the muted "optional/already-done" gray
// used when a linked code PR is still open and there's no rush yet. Used
// both once triage is done (needs-operator-review) and, so a review never
// waits on triage finishing, alongside the triage chips themselves.
function reviewNowChip(pr) {
	return !pr.appPRNumber && !pr.isDraft
		? { cls: "act", text: "Review this docs PR" }
		: { cls: "muted", text: "Review this docs PR" }
}

function chipsFor(pr) {
	const chips = []
	// Needs-rebase and stale are structural/status flags, not action nudges —
	// lead with them so they're never buried under a list of chips.
	const leadingStale = staleChip(pr)
	if (leadingStale) chips.push(leadingStale)
	if (pr.needsRebaseFlag) chips.push({ cls: "manual", text: "Needs rebase" })
	const codeMilestone = codeMilestoneAdvisoryChip(pr)
	if (codeMilestone) chips.push(codeMilestone)
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
			chips.push(reviewNowChip(pr))
			break
		case "needs-label-and-milestone":
			if (!pr.hasLabel) chips.push({ cls: "setup", text: `Add ${PENDING_LABEL} label` })
			if (!pr.hasMilestone) chips.push({ cls: "setup", text: "Add milestone" })
			// Review shouldn't wait on triage finishing — a maintainer can
			// (and should) start reading the content the moment the PR
			// shows up, in parallel with adding the label/milestone. Skipped
			// when reviewPendingFlag already covers it below with the more
			// specific "code PR merged" wording, so the row doesn't show two
			// near-duplicate review chips.
			if (!pr.reviewPendingFlag) chips.push(reviewNowChip(pr))
			break
		case "needs-milestone":
			chips.push({ cls: "setup", text: "Add milestone" })
			if (!pr.reviewPendingFlag) chips.push(reviewNowChip(pr))
			break
		case "blocked-no-code-pr":
			// A qualifying approval settles it too, same as the code-author
			// clock above — unless it still needs a rebase, since the branch
			// itself being wrong is a reason to keep nagging regardless of
			// content approval.
			if (!pr.staleFlag && (!pr.hasQualifyingApproval || pr.needsRebaseFlag)) {
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

	const reviewInProgress = reviewInProgressChip(pr)
	if (reviewInProgress) chips.push(reviewInProgress)

	chips.push(...approvalChips(pr))

	if (pr.finalReviewActionable && !pr.standaloneOperatorReady) {
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

// In team mode, two maintainers can land on the same row at once — without
// this, the only signal that one of them already looked is the review chip's
// absence, which is easy to miss and doesn't say who or that it's still
// open. Fires the moment any operator has reviewed/commented and nobody's
// approved yet; once an approval lands (see approvalChips below), that's the
// more important fact, so this one steps aside rather than doubling up.
function reviewInProgressChip(pr) {
	if (!pr.operatorReviewDone || pr.hasQualifyingApproval || pr.contentApprovedByLabel) {
		return null
	}
	return { cls: "muted", text: `${escapeHtml(pr.operatorReviewActor)} reviewed this` }
}

// "Approved by X" is a fact worth showing on any row, in any band, the
// moment a qualifying approval exists — regardless of category. When that
// approval is the operator's own on a standalone PR, there's nothing left
// to review, so the two facts (approved, ready) collapse into one chip
// instead of "Approved by X" plus a separate "Final review, then merge".
// A comment or review landing after the approval gets its own chip rather
// than silently trusting the approval as the last word.
function approvalChips(pr) {
	const chips = []
	if (pr.approverLogins.length > 0) {
		const names = pr.approverLogins.map(escapeHtml).join(", ")
		chips.push(
			pr.standaloneOperatorReady
				? { cls: "finish", text: `Approved by ${names} — ready to merge` }
				: { cls: "finish", text: `Approved by ${names}` },
		)
	}
	// GitHub dismissed the actual review (new commits landed), but the
	// content-approved label says an operator manually confirmed the
	// dismissal didn't undo the approval — named separately from the chip
	// above so the row stays honest that this isn't a live GitHub approval.
	if (pr.contentApprovedByLabel) {
		const names = pr.dismissedApproverLogins.map(escapeHtml).join(", ")
		chips.push({
			cls: "finish",
			text: `Content approved by ${names} — review dismissed`,
		})
	}
	if (pr.noteSinceApprovalFlag) {
		chips.push({ cls: "act", text: "Note since approval — take a look" })
	}
	return chips
}

// No activity on either PR for 30+ days — a plain inactivity signal, not
// tied to any category, so it can flag a row even when nothing else does.
function staleChip(pr) {
	if (!pr.staleFlag) return null
	return { cls: "stale", text: `🕸 Stale — ${pr.daysSinceActivity}d quiet` }
}

// An early, automatic heads-up that the code PR's milestone — or, absent
// one, its base branch — doesn't match where the docs PR currently sits,
// before anyone's noticed and manually applied needs-rebase (see
// codeMilestoneAdvisoryFlag). Names whichever of branch/milestone is
// actually out of step, since either can lag independently.
function codeMilestoneAdvisoryChip(pr) {
	if (!pr.codeMilestoneAdvisoryFlag) return null
	const code = escapeHtml(pr.codeExpectedBranch)
	const docs = escapeHtml(pr.docsMilestoneBranch)
	const source = pr.codeExpectedFromBaseBranch
		? `Code PR has no milestone and targets ${escapeHtml(pr.codeBaseBranch)} — next is ${code}`
		: `Code PR milestone is ${code}`
	if (pr.codeMilestoneBranchMismatch && pr.codeMilestoneDocsMismatch) {
		return {
			cls: "manual",
			text: `${source} — docs targets ${escapeHtml(pr.baseBranch)} and is milestoned ${docs}, both should follow`,
		}
	}
	if (pr.codeMilestoneBranchMismatch) {
		return {
			cls: "manual",
			text: `${source} — docs targets ${escapeHtml(pr.baseBranch)}, check destination branch`,
		}
	}
	return {
		cls: "manual",
		text: `${source} — docs is milestoned ${docs}, update it`,
	}
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
// These categories carry their own dedicated nudge/action chip (Remind /
// Check the author's response / Send a follow-up / Escalate), which already
// signals "you're the one waiting" on its own — naming the pinger on top of
// that chip is redundant regardless of who sent it, so these stay suppressed
// unconditionally, same as before.
const NAMED_BY_OWN_CHIP = new Set([
	"needs-remind-code-author",
	"needs-check-author-response",
	"needs-followup",
	"needs-escalate-core-team",
])

function remindedOpenChip(pr) {
	// Otherwise, skip this only when the category's own metaLine text
	// already names the same outstanding tag (e.g.
	// waiting-code-author-response's "X reminded the author, waiting for a
	// reply") — which only happens when the ping wasn't from an operator; an
	// operator ping renders generically there ("reminder sent, waiting for a
	// reply") without naming anyone, so for these passive categories (no
	// chip of their own) this chip is what's left to actually say who.
	const alreadyNamedInline =
		NAMED_BY_OWN_CHIP.has(pr.category) ||
		(pr.category === "waiting-code-author-response" && !pr.lastPingByOperator)
	if (pr.community.lit && pr.community.waitingOnKind === "author" && !alreadyNamedInline) {
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
	const reviewInProgress = reviewInProgressChip(pr)
	if (reviewInProgress) chips.push(reviewInProgress)

	chips.push(...approvalChips(pr))
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
	const chips = chipsFor(pr)
	const chipsHtml = chips.map((c) => `<span class="chip ${c.cls}">${c.text}</span>`).join("")
	const draftPill = pr.isDraft ? ' <span class="pill draft">Draft</span>' : ""
	const key = cacheKey(pr.sourceRepo, pr.number)
	const rowLabel = `${pr.repoShort} #${pr.number}: ${pr.title}`
	const search = escapeHtml(searchBlobFor(pr, chips))
	return `
      <article class="row" data-sev="${sev}" data-repo="${escapeHtml(pr.repoShort)}" data-stale="${pr.staleFlag ? "1" : "0"}" data-approved="${pr.finalReviewActionable ? "1" : "0"}" data-key="${escapeHtml(key)}" data-search="${search}">
        <div class="chk"><input type="checkbox" aria-label="Mark ${escapeHtml(rowLabel)} as done"></div>
        <div class="edge"></div>
        <div class="body">
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
	const key = cacheKey(pr.sourceRepo, pr.number)
	const rowLabel = `${pr.repoShort} #${pr.number}: ${pr.title}`
	const search = escapeHtml(searchBlobFor(pr, chips))
	return `
      <article class="row" data-sev="none" data-repo="${escapeHtml(pr.repoShort)}" data-stale="${pr.staleFlag ? "1" : "0"}" data-key="${escapeHtml(key)}" data-search="${search}">
        <div class="chk"><input type="checkbox" aria-label="Mark ${escapeHtml(rowLabel)} as done"></div>
        <div class="edge"></div>
        <div class="body">
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
	const overlayChipObjs = [staleChip(pr), remindedOpenChip(pr), ...approvalChips(pr)].filter(
		Boolean,
	)
	const overlayChips = overlayChipObjs
		.map((c) => `<span class="chip ${c.cls}">${c.text}</span>`)
		.join("")
	const reviewPendingChip = pr.reviewPendingFlag
		? { cls: "act", text: "Review this docs PR — code PR merged" }
		: null
	const reviewChip = reviewPendingChip
		? `<span class="chip ${reviewPendingChip.cls}">${reviewPendingChip.text}</span>`
		: ""
	const search = escapeHtml(
		searchBlobFor(pr, [...overlayChipObjs, reviewPendingChip].filter(Boolean)),
	)
	return `<div class="mon-row" data-repo="${escapeHtml(pr.repoShort)}" data-stale="${pr.staleFlag ? "1" : "0"}" data-search="${search}"><a href="${pr.url}" target="_blank">${escapeHtml(pr.repoShort)} #${pr.number}</a> ${codePart} <span class="why">${dayText}</span>${reviewChip}${overlayChips}</div>`
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
// sorted alphabetically so the page reads like a directory; within each
// person's own items, a live "respond" tag outranks a plain "review" ask —
// someone's waiting on a reply — and each of those two buckets is
// oldest-first, since that's the most overdue.
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
			if (a.mark.kind !== b.mark.kind) return a.mark.kind === "respond" ? -1 : 1
			const da = a.mark.sortDate ? a.mark.sortDate.getTime() : 0
			const db = b.mark.sortDate ? b.mark.sortDate.getTime() : 0
			return da - db
		})
		return { author, items }
	})
}

function generateHTML(prData, { operatorUsername }) {
	// Bring-forward is carved entirely out of what would otherwise be
	// Need-today — never out of Waiting or Monitoring, which are untouched.
	const needToday = prData.filter((p) => isNeedTodayRow(p) && !isBringForwardRow(p))
	const bringForward = prData.filter((p) => isNeedTodayRow(p) && isBringForwardRow(p))
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
	bringForward.sort((a, b) => {
		const ra = bringForwardRank(a)
		const rb = bringForwardRank(b)
		if (ra !== rb) return ra - rb
		// Stale group: newest activity first, longest-quiet last — the
		// opposite of the other two groups, where the most-overdue row leads.
		if (ra === 2) return (a.daysSinceActivity ?? 0) - (b.daysSinceActivity ?? 0)
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

	const newTriageCount = bringForward.filter(
		(p) => p.category === "needs-label-and-milestone" || p.category === "needs-milestone",
	).length
	const readyCount = bringForward.filter((p) => isCleanApprovedRow(p)).length
	const bringForwardStaleCount = bringForward.filter((p) => p.staleFlag).length
	const bringForwardBits = []
	if (newTriageCount > 0) bringForwardBits.push(`${newTriageCount} new`)
	if (readyCount > 0) bringForwardBits.push(`${readyCount} ready to merge`)
	if (bringForwardStaleCount > 0)
		bringForwardBits.push(`<span class="dot stale"></span>${bringForwardStaleCount} stale`)
	const bringForwardSub = bringForwardBits.join(" · ")

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
	// Act and Stale both span every band — Bring it forward carries its own
	// actionable (new-PR, clean-approved) rows and stale rows, and picking
	// either tab is meant to surface those too rather than hide them.
	sevCounts.act += bringForward.filter((p) => severityFor(p) === "act").length
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
	const searchBar = `
  <div class="search-bar">
    <div class="search-input-wrap">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input type="search" id="prSearch" class="search-input" placeholder="Search by PR #, title, author, or label text…" aria-label="Search pull requests by number, title, author, or label text" autocomplete="off" spellcheck="false">
      <button type="button" id="prSearchClear" class="search-clear" aria-label="Clear search" hidden>✕</button>
    </div>
    <span class="search-hint">Press <kbd>/</kbd> anywhere to jump here</span>
    <span class="search-summary" id="prSearchSummary" role="status" hidden></span>
  </div>`
	const filterBar = `
  <div class="filters">
    <div class="fbar" role="group" aria-label="Filter by repo"><span class="fbar-label">Repo</span>${repoTabs}</div>
    <div class="fbar" role="group" aria-label="Filter by priority"><span class="fbar-label">Priority</span>${priorityTabs}</div>
    <div class="fbar" role="group" aria-label="Checklist"><span class="fbar-label">Checklist</span><button class="switch-ctrl" id="hideCheckedBtn" type="button" role="switch" aria-checked="false"><span class="switch-track"><span class="switch-thumb"></span></span><span class="switch-text">Hide checked rows <span class="fc">0</span></span></button></div>
  </div>`

	const needTodaySection =
		needToday.length > 0
			? `
  <section data-band="today">
    <div class="sec-head">
      <h2>Need you today</h2><span class="count">${needToday.length}</span>
      <span class="chk-progress" data-state="zero">0/${needToday.length} checked</span>
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
    <p class="tail">${bringForward.length} to bring forward · ${waiting.length} waiting on others · ${monitoring.length} monitoring</p>
  </div>`

	const bringForwardSection =
		bringForward.length > 0
			? `
  <section class="band-secondary" data-band="forward">
    <div class="sec-head">
      <h2>Bring it forward</h2><span class="count">${bringForward.length}</span>
      <span class="chk-progress" data-state="zero">0/${bringForward.length} checked</span>
      <span class="hint">not urgent — new PRs to triage, approvals ready to merge, anything gone quiet</span>
      <span class="no-match">no rows match this filter</span>
    </div>
    <div class="card">${bringForward.map(renderNeedTodayRow).join("")}
    </div>
  </section>`
			: ""

	const waitingSection =
		waiting.length > 0
			? `
  <section class="band-secondary" data-band="waiting">
    <div class="sec-head">
      <h2>Waiting on others or for code PR to merge</h2><span class="count">${waiting.length}</span>
      <span class="chk-progress" data-state="zero">0/${waiting.length} checked</span>
      <span class="hint">the ball is in someone else's court — the tracker watches the clock</span>
      <span class="no-match">no rows match this filter</span>
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
      <span class="no-match">no rows match this filter</span>
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
<script>
  (function(){
    try {
      var saved = localStorage.getItem('docsPrTrackerTheme');
      if (saved === 'dark' || saved === 'light') {
        document.documentElement.setAttribute('data-theme', saved);
      }
    } catch (e) {}
  })();
</script>
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
  .dot.act{background:var(--accent)}
  .dot.triage{background:var(--ink-3)}
  .dot.stale{background:var(--warning)}

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
  .chk-progress{
    display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:1px 8px;
    background:color-mix(in srgb, var(--ink) 7%, transparent);color:var(--ink-3);
  }
  /* Some checked but not all - same accent used for "Act" chips elsewhere. */
  .chk-progress[data-state="partial"]{
    background:color-mix(in srgb, var(--accent) 11%, var(--surface));
    color:color-mix(in srgb, var(--accent) 78%, var(--ink));
  }
  /* Whole band checked off - same green used for "ready to merge" elsewhere. */
  .chk-progress[data-state="done"]{
    background:color-mix(in srgb, var(--good) 12%, var(--surface));
    color:color-mix(in srgb, var(--good) 62%, var(--ink));
  }
  .card{
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    box-shadow:var(--shadow);overflow:hidden;
  }

  .row{
    position:relative;
    display:grid;grid-template-columns:18px 4px 1fr auto;gap:0 14px;
    padding:12px 16px 12px 12px;border-bottom:1px solid var(--line);
    align-items:center;
  }
  .row:last-child{border-bottom:none}
  .row .chk{display:flex;align-items:center;justify-content:center}
  .row .chk input[type=checkbox]{width:15px;height:15px;cursor:pointer}
  .row .chk input[type=checkbox]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .row .edge{width:4px;border-radius:2px;background:var(--line);align-self:stretch}
  .row[data-sev="critical"] .edge{background:var(--critical)}
  .row[data-sev="serious"]  .edge{background:var(--serious)}
  .row[data-sev="act"]      .edge{background:var(--accent)}
  .row[data-sev="triage"]   .edge{background:var(--ink-3)}
  .row[data-sev="dismiss"]  .edge{background:var(--dismiss)}
  /* Stale overrides whatever severity color would otherwise show - it's a
     different kind of signal ("gone quiet") than urgency. */
  .row[data-stale="1"]      .edge{background:var(--warning)}
  /* Approved-and-ready-to-merge wins over both severity and staleness - it's
     the one state that's actually good news. */
  .row[data-approved="1"]   .edge{background:var(--good)}
  /* Checked rows dim in place rather than disappearing (unless "Hide
     checked" is on) - only the title gets struck through, meta/chips stay
     legible so you can still see why the row was there. */
  .row.checked .edge{opacity:.5}
  .row.checked .body,.row.checked .when{opacity:.65}
  .row.checked .title{text-decoration:line-through}

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
  .switch-ctrl{
    font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;
    border:none;background:none;padding:2px 0;color:var(--ink-2);
    display:inline-flex;align-items:center;gap:8px;
  }
  .switch-track{
    position:relative;width:34px;height:20px;border-radius:999px;
    background:var(--line);flex-shrink:0;transition:background .15s;
  }
  .switch-thumb{
    position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
    background:var(--surface);box-shadow:0 1px 2px rgba(11,11,11,.15);
    transition:transform .15s;
  }
  .switch-ctrl[aria-checked="true"]{color:color-mix(in srgb, var(--accent) 80%, var(--ink))}
  .switch-ctrl[aria-checked="true"] .switch-track{background:var(--accent)}
  .switch-ctrl[aria-checked="true"] .switch-thumb{transform:translateX(14px)}
  .switch-ctrl:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:999px}
  .switch-ctrl .fc{
    font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;
    background:color-mix(in srgb, var(--ink) 8%, transparent);
    border-radius:999px;padding:0 6px;color:var(--ink-2);
  }
  .switch-ctrl[aria-checked="true"] .fc{background:color-mix(in srgb, var(--accent) 22%, transparent)}

  /* ---------- quick search ---------- */
  .search-bar{
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;
  }
  .search-input-wrap{position:relative;flex:1;min-width:220px;display:flex;align-items:center}
  .search-icon{
    position:absolute;left:12px;color:var(--ink-3);font-size:15px;pointer-events:none;line-height:1;
  }
  .search-input{
    width:100%;font:inherit;font-size:13.5px;color:var(--ink);
    background:var(--surface);border:1px solid var(--ring);border-radius:10px;
    padding:9px 34px 9px 33px;box-shadow:var(--shadow);
  }
  .search-input::placeholder{color:var(--ink-3)}
  .search-input:focus-visible{outline:2px solid var(--accent);outline-offset:-1px}
  .search-input::-webkit-search-cancel-button{display:none}
  .search-clear{
    position:absolute;right:5px;border:none;background:none;color:var(--ink-3);
    cursor:pointer;font-size:12px;padding:5px 7px;border-radius:6px;line-height:1;font-family:inherit;
  }
  .search-clear:hover{color:var(--ink);background:color-mix(in srgb, var(--ink) 8%, transparent)}
  .search-clear:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .search-hint{font-size:11px;color:var(--ink-3);white-space:nowrap}
  .search-hint kbd{
    font-family:ui-monospace,monospace;font-size:10.5px;border:1px solid var(--ring);
    border-radius:4px;padding:0 5px;background:color-mix(in srgb, var(--ink) 5%, transparent);
  }
  .search-summary{
    flex-basis:100%;font-size:12px;color:var(--ink-3);
  }
  .search-summary.no-results{color:var(--critical);font-weight:600}
  mark.search-hit{
    background:color-mix(in srgb, var(--warning) 55%, transparent);color:inherit;
    border-radius:2px;padding:0 1px;
  }

  .row.hidden,.mon-row.hidden{display:none}
  .no-match{font-size:12px;color:var(--ink-3);display:none}
  section.all-hidden .no-match{display:inline}
  section.all-hidden .card{display:none}
  /* choosing a specific priority hides the lower-priority bands entirely */
  /* Stale and Act both span every band — Bring it forward genuinely has
     actionable (new-PR, clean-approved) and stale rows of its own — so
     picking either shouldn't hide it. Critical/Serious/Triage stay
     Need-today-only escalation states, so they still hide everything else. */
  body:not([data-fpri="all"]):not([data-fpri="stale"]):not([data-fpri="act"]) .band-secondary{display:none}

  @media (max-width:640px){
    body{padding:16px 10px 40px}
    .stats{grid-template-columns:1fr;gap:8px}
    .tile{display:flex;align-items:baseline;gap:10px;padding:10px 14px}
    .tile .num{font-size:22px}
    .tile .sub{margin-left:auto;text-align:right}
    .legend td:first-child{white-space:normal;width:auto;display:block;padding-bottom:2px}
    .legend tr{display:block;padding:6px 0;border-bottom:1px solid var(--line)}
    .legend tr td{border-bottom:none;padding-left:0}
    .row{grid-template-columns:4px 1fr;row-gap:6px;padding:10px 44px 10px 12px}
    .row .chk{position:absolute;top:10px;right:10px}
    .when{grid-column:2;text-align:left;display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
    .when .sub{margin-top:0}
    .meter{margin:0}
    .mon-row .why{margin-left:0;width:100%}
    .search-hint{display:none}
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
    <span class="updated" data-updated-iso="${now.toISOString()}">Updated ${formatUpdated(now)}</span>
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
    <button class="tile" data-goto="forward" type="button">
      <div class="num">${bringForward.length}</div>
      <div><div class="lbl">Bring it forward</div>
      <div class="sub">${bringForwardSub}</div></div>
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
${searchBar}
${filterBar}
  <details class="legend">
    <summary><span class="tw">▶</span> New here? How to read this board</summary>
    <div class="legend-body">

      <section>
        <h2 class="legend-h">1. The four groups — whose turn is it?</h2>
        <table>
          <tr><td><b>Need you today</b></td><td>Actions only you can take, most urgent first.</td></tr>
          <tr><td><b>Bring it forward</b></td><td>Not urgent, but worth doing on your own schedule — brand-new PRs that still need a label or milestone, approvals that are ready to merge with nothing else going on, and anything that's gone quiet for a while (stale).</td></tr>
          <tr><td><b>Waiting on others or for code PR to merge</b></td><td>You've done your part — either the code PR hasn't merged yet, or a reminder to the code PR author has been sent.</td></tr>
          <tr><td><b>Monitoring</b></td><td>The author replied and you've already responded. Collapsed by default — if the conversation goes quiet for a week, it resurfaces so you can send another reminder.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">2. Filters — narrowing what you see</h2>
        <p class="legend-note">Both filter bars live at the top of the page, above the groups.</p>
        <table>
          <tr><td><b>Repo</b></td><td>Switches the whole board to show just one repo. The counts on each tab are totals across all four groups.</td></tr>
          <tr><td><b>Priority</b></td><td><b>Critical</b>, <b>Serious</b>, and <b>Triage</b> only apply to <b>Need you today</b> — picking one of these hides the other three groups entirely. <b>Act</b> and <b>Stale</b> work differently: they show up in every group instead of hiding the rest, since <b>Bring it forward</b> has its own actionable and stale rows too. Counts follow whichever repo tab is selected.</td></tr>
        </table>
        <table>
          <tr><td><span class="dot critical"></span><b>Critical</b></td><td>You reminded the code author ${ESCALATE_DAYS}+ days ago and it's still quiet — escalate to the core team.</td></tr>
          <tr><td><span class="dot serious"></span><b>Serious</b></td><td>You reminded the code author ${FOLLOWUP_DAYS}–${ESCALATE_DAYS} days ago, or someone's waiting directly on your reply — send a follow-up.</td></tr>
          <tr><td><span class="dot act"></span><b>Act</b></td><td>Something needs doing: check the author's response, remind the code author, review a standalone PR, do a final review on an approval that has something else attached, add a label/milestone to a new PR, or merge one that's cleanly approved and ready.</td></tr>
          <tr><td><span class="dot triage"></span><b>Triage</b></td><td>Review a draft PR — still waiting the code PR to merge — or, for a standalone PR, waiting on its author before it escalates.</td></tr>
          <tr><td><span class="dot stale"></span><b>🕸 Stale</b></td><td>No activity on the PR for 30+ days.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">3. Reading a row</h2>
        <table>
          <tr><td><span class="edge-sample"></span> Left edge</td><td>Urgency at a glance: red overdue → orange due soon → blue actionable → grey triage → green approved/ready to merge.</td></tr>
          <tr><td><span class="pill open">Open</span></td><td>A <b>badge</b> — a fact about the code PR: Draft / Open / Merged / Closed.</td></tr>
          <tr><td><span class="chip act">Review this docs PR</span></td><td>A <b>label</b> — an action for you. Colour = the type of task (see below).</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">4. Colour key — same kind of task, same colour</h2>
        <table>
          <tr><td><span class="chip setup">Setup &amp; triage</span></td><td>Add milestone (every new PR) · Add ${PENDING_LABEL} label (drafts) · Add ${BACKPORT_LABEL} label (older branch)</td></tr>
          <tr><td><span class="chip nudge1">Remind</span> <span class="chip nudge2">Follow up</span> <span class="chip nudge3">Escalate</span></td><td>The same colour, getting more intense the more urgent it gets: Remind → Follow up → Escalate.</td></tr>
          <tr><td><span class="chip act">Review / respond</span></td><td>Review this docs PR (standalone, awaiting your review) · Check the author's response · Note since approval.</td></tr>
          <tr><td><span class="chip finish">Finish &amp; merge</span></td><td>Final review, then merge · Remove ${PENDING_LABEL} label · Approved by X · Approved — ready to merge.</td></tr>
          <tr><td><span class="chip backport">Backport first</span></td><td>Must be backported before it can merge.</td></tr>
          <tr><td><span class="chip manual">Manual attention</span></td><td>No code PR linked · someone's waiting on a reply · docs PR needs a rebase · code PR's milestone doesn't match the docs branch/milestone yet.</td></tr>
          <tr><td><span class="chip muted">Optional / already done</span></td><td>Review draft PR · a reminder you already sent · X reviewed this (someone's looked, no approval yet).</td></tr>
          <tr><td><span class="chip dismiss">Close / dismiss</span></td><td>Close this docs PR — its code PR was closed.</td></tr>
          <tr><td><span class="chip stale">🕸 Stale</span></td><td>No activity on the PR for 30+ days.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">5. Live threads &amp; approvals</h2>
        <table>
          <tr><td>👀 Live threads</td><td>An unanswered human comment on the docs PR. Orange if someone's waiting on <b>you</b>; also shown if someone outside the review team is waiting on the <b>code author</b> — checked separately, so a later unrelated reply to someone else can't hide it. Once the PR is approved, only what's been said since that approval counts — earlier comments don't. Otherwise, it's just there so you can keep an eye on it. Includes Promptless when it @-mentions a reviewer outside your team for feedback.</td></tr>
          <tr><td>Approvals</td><td>"Approved by X" is a label shown wherever there's an active approval — whether that's you, a teammate, or someone else (the one exception: a PR author can't approve their own PR, except for one admin account GitHub allows this for). "Final review, then merge" only appears once the code PR has merged. For a standalone PR with no code PR to wait on, your own approval combines both into one label: "Approved by X — ready to merge". Anything added after the approval gets its own "Note since approval" label.</td></tr>
          <tr><td>Content-approved label</td><td>GitHub automatically removes an approval the moment new commits land — even if the push only addresses unrelated feedback. When that happens, the "Approved by X" label and everything it unlocked (final review, the escalation shortcut) disappear too. If you've checked and the new commits didn't actually change what was approved, add the <code>${CONTENT_APPROVED_LABEL}</code> label yourself: the row gets a separate "Content approved by X — review dismissed" label, naming the reviewer, and everything behaves as if the approval were still standing.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">6. Follow-up &amp; escalation timeline</h2>
        <p class="legend-note">Only a comment that <b>@-mentions the code author</b> starts this timeline — yours or a teammate's, not just a regular reply — and it stops the moment the author replies.</p>
        <table>
          <tr><td>Day 0</td><td>Code PR merges, someone @-mentions the code author.</td></tr>
          <tr><td>Day ${FOLLOWUP_DAYS}</td><td>Row asks for a follow-up.</td></tr>
          <tr><td>Day ${ESCALATE_DAYS}</td><td>Row asks you to escalate to the core team.</td></tr>
          <tr><td>Any day</td><td>Author replies — the row asks you to check their response.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">7. Good to know</h2>
        <table>
          <tr><td>Review vs. the timeline</td><td>The remind/follow-up/escalate timeline no longer waits on you having formally reviewed the docs PR — it only needs the code PR to have merged. If review's still outstanding, a separate "Review this docs PR — code PR merged" label shows up alongside whatever the timeline shows.</td></tr>
          <tr><td>Review vs. triage</td><td>A brand-new PR still missing its label/milestone also gets a "Review this docs PR" label right away, alongside the setup chips — reading the content doesn't have to wait on triage being finished.</td></tr>
          <tr><td>Labels</td><td><code>${PENDING_LABEL}</code> — removed once the code PR merges. <code>${BACKPORT_LABEL}</code> — added when a PR targets an older branch than the latest. <code>${NEEDS_REBASE_LABEL}</code> — just shown as-is, it doesn't affect timing. <code>${CONTENT_APPROVED_LABEL}</code> — add it yourself after confirming a GitHub-dismissed approval still stands; see "Content-approved label" above.</td></tr>
        </table>
      </section>

      <section>
        <h2 class="legend-h">8. Your personal checklist</h2>
        <p class="legend-note">Every row in Need you today, Bring it forward, and Waiting has a checkbox — Monitoring doesn't, since it's already "nothing to do."</p>
        <table>
          <tr><td><input type="checkbox" disabled></td><td>Tick it off once you've actually handled a row. It's saved to <b>your own browser only</b> — nobody else sees it, and it won't change anything on GitHub or on this page's data. The row dims and its title gets struck through; clearing your browser data resets everything.</td></tr>
          <tr><td><span class="chk-progress" data-state="partial">2/5 checked</span></td><td>Each group's header shows its own progress, always out of the <b>whole group</b> — not just whatever's currently filtered into view. Grey while untouched, blue while in progress, green with a ✓ once every row in that group is checked off.</td></tr>
          <tr><td><b>Hide checked rows</b></td><td>A switch next to the Repo/Priority filters (Checklist row) that collapses checked rows out of view instead of just dimming them. Your checked state is exactly the same either way — this only changes what's shown.</td></tr>
        </table>
      </section>

    </div>
  </details>
${needTodaySection}
${bringForwardSection}
${waitingSection}
${monitoringSection}
  </main>
  <footer>Generated by <code>node tracker.js</code> as <code>${escapeHtml(operatorUsername)}</code> · <span data-updated-iso="${now.toISOString()}">${formatUpdated(now)}</span></footer>
</div>

<button class="back-to-top" id="backToTop" type="button" aria-label="Back to top" title="Back to top">↑</button>

<script>
  // "Updated" timestamps are baked in at build time in the CI runner's
  // timezone (UTC); re-render them here so visitors see their own
  // machine's local time instead.
  document.querySelectorAll('[data-updated-iso]').forEach(function(el){
    el.textContent = new Date(el.getAttribute('data-updated-iso')).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  });

  function toggleTheme(){
    const r = document.documentElement;
    const cur = r.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', next);
    try { localStorage.setItem('docsPrTrackerTheme', next); } catch (e) {}
  }

  // ---- filter tabs (repo + priority + search) ----
  const filterState = { repo: 'all', pri: 'all', hideChecked: false, search: '' };
  document.body.setAttribute('data-frepo', 'all');
  document.body.setAttribute('data-fpri', 'all');

  // Wraps the first match of the query inside el's text in a mark tag, so a title
  // hit is visible at a glance instead of a maintainer having to reread the
  // whole row to see why it matched. Caches the untouched text on first run
  // so repeated searches (and clearing) always restore from the original,
  // never from a previously-marked-up version.
  function highlightMatch(el, query){
    if (!el) return;
    if (el.dataset.orig === undefined) el.dataset.orig = el.textContent;
    const original = el.dataset.orig;
    if (!query) { el.textContent = original; return; }
    const idx = original.toLowerCase().indexOf(query);
    if (idx === -1) { el.textContent = original; return; }
    el.textContent = '';
    el.appendChild(document.createTextNode(original.slice(0, idx)));
    const mark = document.createElement('mark');
    mark.className = 'search-hit';
    mark.textContent = original.slice(idx, idx + query.length);
    el.appendChild(mark);
    el.appendChild(document.createTextNode(original.slice(idx + query.length)));
  }

  function applyFilters(){
    const { repo, pri, hideChecked, search } = filterState;
    // A specific severity priority is meaningful only in "Need you today";
    // the CSS hides the Waiting/Monitoring bands whenever pri is a severity.
    // "stale" is different — it spans every band, so it filters rows within
    // each band instead of hiding whole bands.
    document.querySelectorAll('.row').forEach(function(row){
      const okRepo = repo === 'all' || row.getAttribute('data-repo') === repo;
      const okPri  = pri === 'all' ||
        (pri === 'stale' ? row.getAttribute('data-stale') === '1' : row.getAttribute('data-sev') === pri);
      const okChecked = !hideChecked || !row.classList.contains('checked');
      const okSearch = !search || (row.getAttribute('data-search') || '').indexOf(search) !== -1;
      row.classList.toggle('hidden', !(okRepo && okPri && okChecked && okSearch));
      highlightMatch(row.querySelector('.title .desc'), search);
    });
    document.querySelectorAll('.mon-row').forEach(function(row){
      const okRepo = repo === 'all' || row.getAttribute('data-repo') === repo;
      const okPri = pri === 'all' || (pri === 'stale' && row.getAttribute('data-stale') === '1');
      const okSearch = !search || (row.getAttribute('data-search') || '').indexOf(search) !== -1;
      row.classList.toggle('hidden', !(okRepo && okPri && okSearch));
    });
    // A search hit tucked inside the collapsed Monitoring panel is invisible
    // unless the panel is open — open it automatically so search always
    // surfaces what it finds, the same way the summary tiles do (see the
    // data-goto click handler below).
    if (search) {
      document.querySelectorAll('section[data-band] details.mon').forEach(function(d){
        const anyVisible = Array.prototype.some.call(
          d.querySelectorAll('.mon-row'),
          function(r){ return !r.classList.contains('hidden'); },
        );
        if (anyVisible) d.open = true;
      });
    }
    // Recompute per-section visible counts and empty states.
    document.querySelectorAll('section[data-band]').forEach(function(sec){
      const rows = sec.querySelectorAll('.row, .mon-row');
      let vis = 0;
      rows.forEach(function(r){ if(!r.classList.contains('hidden')) vis++; });
      const badge = sec.querySelector('.sec-head .count');
      if (badge) badge.textContent = vis;
      const hiddenByBand = sec.classList.contains('band-secondary') &&
        pri !== 'all' && pri !== 'stale' && pri !== 'act';
      sec.classList.toggle('all-hidden', vis === 0 && !hiddenByBand);
    });
    const searchSummary = document.getElementById('prSearchSummary');
    if (searchSummary) {
      if (!search) {
        searchSummary.hidden = true;
      } else {
        let total = 0;
        document.querySelectorAll('.row, .mon-row').forEach(function(r){
          if (!r.classList.contains('hidden')) total++;
        });
        searchSummary.hidden = false;
        searchSummary.classList.toggle('no-results', total === 0);
        const q = document.getElementById('prSearch').value.trim();
        searchSummary.textContent = total === 0
          ? 'No PRs match “' + q + '”'
          : total + ' PR' + (total === 1 ? '' : 's') + ' match “' + q + '”';
      }
    }
    // Priority tab counts follow the repo selection — "3 triage" should mean
    // 3 in the repo you're looking at, not 3 across everything. These counts
    // ignore the *priority* filter itself (each tab shows what it would find
    // if you picked it next). Critical/Serious/Triage are Need-today-only
    // escalation states; Act and Stale both span every band — Bring it
    // forward has actionable and stale rows of its own — so they count
    // across everything, to match what picking either actually reveals.
    const todayRows = document.querySelectorAll('section[data-band="today"] .row');
    const bySev = { critical: 0, serious: 0, triage: 0 };
    let repoTotal = 0;
    todayRows.forEach(function(row){
      if (repo !== 'all' && row.getAttribute('data-repo') !== repo) return;
      repoTotal++;
      const sev = row.getAttribute('data-sev');
      if (bySev[sev] != null) bySev[sev]++;
    });
    let staleTotal = 0;
    let actTotal = 0;
    document.querySelectorAll('.row, .mon-row').forEach(function(row){
      if (repo !== 'all' && row.getAttribute('data-repo') !== repo) return;
      if (row.getAttribute('data-stale') === '1') staleTotal++;
      if (row.getAttribute('data-sev') === 'act') actTotal++;
    });
    document.querySelectorAll('.ftab[data-f="pri"]').forEach(function(tab){
      const fc = tab.querySelector('.fc');
      if (!fc) return;
      const v = tab.getAttribute('data-v');
      if (v === 'all') fc.textContent = repoTotal;
      else if (v === 'stale') fc.textContent = staleTotal;
      else if (v === 'act') fc.textContent = actTotal;
      else fc.textContent = bySev[v] || 0;
    });
  }

  document.querySelectorAll('.ftab[data-f]').forEach(function(tab){
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

  // ---- quick search ----
  (function(){
    const input = document.getElementById('prSearch');
    const clearBtn = document.getElementById('prSearchClear');
    if (!input) return;

    function runSearch(){
      const q = input.value.toLowerCase().trim();
      filterState.search = q;
      clearBtn.hidden = q === '';
      applyFilters();
    }

    input.addEventListener('input', runSearch);
    clearBtn.addEventListener('click', function(){
      input.value = '';
      runSearch();
      input.focus();
    });
    input.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        input.value = '';
        runSearch();
      }
    });
    // "/" to jump into search is a common list-page convention (GitHub,
    // Gmail, Slack) — skipped while any other field already has focus (or
    // mid-IME-composition) so it doesn't hijack normal typing. Registered
    // on the capture phase and paired with select() below as a belt-and-
    // braces guard against the "/" itself leaking into the input on the
    // same keystroke that focuses it.
    document.addEventListener('keydown', function(e){
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const ae = document.activeElement;
      const editable = ae && (ae === input || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
        ae.tagName === 'SELECT' || ae.isContentEditable);
      if (editable) return;
      e.preventDefault();
      input.focus();
      input.select();
    }, true);
  })();

  // ---- checklist (saved to this browser only, via localStorage) ----
  (function(){
    var STORE_KEY = 'docsPrTrackerChecklist';
    var state = {};
    try { state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { state = {}; }

    var hideCheckedBtn = document.getElementById('hideCheckedBtn');
    function updateHideCheckedCount(){
      if (!hideCheckedBtn) return;
      var fc = hideCheckedBtn.querySelector('.fc');
      if (fc) fc.textContent = document.querySelectorAll('.row.checked').length;
    }
    // Per-band progress ("10/40 checked") - always counts the whole band,
    // not just what's currently visible, so it stays a stable progress
    // tracker regardless of the repo/priority filters or "Hide checked".
    function updateBandProgress(){
      document.querySelectorAll('.chk-progress').forEach(function(el){
        var sec = el.closest('section[data-band]');
        if (!sec) return;
        var total = sec.querySelectorAll('.row[data-key]').length;
        var done = sec.querySelectorAll('.row[data-key].checked').length;
        var allDone = total > 0 && done === total;
        el.textContent = done + '/' + total + ' checked' + (allDone ? ' ✓' : '');
        el.setAttribute('data-state', allDone ? 'done' : (done > 0 ? 'partial' : 'zero'));
      });
    }

    var validKeys = {};
    document.querySelectorAll('.row[data-key]').forEach(function(row){
      var key = row.getAttribute('data-key');
      validKeys[key] = true;
      var cb = row.querySelector('.chk input[type=checkbox]');
      if (!cb) return;
      if (state[key]) { cb.checked = true; row.classList.add('checked'); }
      cb.addEventListener('change', function(){
        if (cb.checked) { state[key] = true; row.classList.add('checked'); }
        else { delete state[key]; row.classList.remove('checked'); }
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
        updateHideCheckedCount();
        updateBandProgress();
        applyFilters();
      });
    });
    // Drop saved keys for rows no longer listed (already resolved) so
    // localStorage doesn't grow forever with stale entries.
    var changed = false;
    Object.keys(state).forEach(function(k){
      if (!validKeys[k]) { delete state[k]; changed = true; }
    });
    if (changed) localStorage.setItem(STORE_KEY, JSON.stringify(state));

    updateHideCheckedCount();
    updateBandProgress();
    if (hideCheckedBtn) {
      hideCheckedBtn.addEventListener('click', function(){
        const active = hideCheckedBtn.getAttribute('aria-checked') !== 'true';
        hideCheckedBtn.setAttribute('aria-checked', active ? 'true' : 'false');
        filterState.hideChecked = active;
        applyFilters();
      });
    }
  })();

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
          <td data-label="Docs PR"><a href="${pr.url}" target="_blank">${escapeHtml(pr.repoShort)} #${pr.number}</a> ${escapeHtml(pr.title)}</td>
          <td data-label="Code PR">${codePRHtml}</td>
          <td data-label="Mark">${markHtml}</td>
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
<script>
  (function(){
    try {
      var saved = localStorage.getItem('docsPrTrackerTheme');
      if (saved === 'dark' || saved === 'light') {
        document.documentElement.setAttribute('data-theme', saved);
      }
    } catch (e) {}
  })();
</script>
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
  .intro p{margin:0 0 8px}
  .intro p:last-child,.intro ul:last-child{margin-bottom:0}
  .intro .intro-lead{font-weight:600;color:var(--ink);margin:12px 0 4px}
  .intro ul{margin:0 0 8px 18px}
  .intro li{margin:2px 0}

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
    table{display:block;border:none;border-radius:0;box-shadow:none;background:none}
    thead{display:none}
    tbody{display:block}
    tr{
      display:block;position:relative;
      background:var(--surface);border:1px solid var(--ring);border-radius:10px;
      box-shadow:var(--shadow);padding:10px 44px 10px 12px;margin-bottom:10px;
    }
    td{display:block;border-top:none;padding:3px 0;width:auto}
    td.chk{position:absolute;top:10px;right:10px;padding:0}
    td[data-label]::before{
      content:attr(data-label);display:block;font-size:11px;
      text-transform:uppercase;letter-spacing:.03em;color:var(--ink-3);
      font-weight:600;margin-bottom:2px;
    }
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
    <span class="updated" data-updated-iso="${now.toISOString()}">Updated ${formatUpdated(now)}</span>
    <a class="nav-link" href="tracker-report.html">← Dashboard</a>
    <button class="theme-btn" onclick="toggleTheme()">◐ Theme</button>
  </div>

  <div class="intro">
    <p>
      Docs PRs waiting on <b>your</b> review or response to a comment,
      grouped by name — either your linked code PR has merged, or it's a
      docs PR you opened yourself that's waiting on your reply.
    </p>
    <p class="intro-lead">Using this list:</p>
    <ul>
      <li>Click your name below to jump straight to your section.</li>
      <li>
        Check a box to track your progress — it saves to <b>your own
        browser</b> only. The reminder list updates when the tracker runs on
        schedule.
      </li>
    </ul>
    <p class="intro-lead">To review a PR:</p>
    <ul>
      <li>Open its <b>Files changed</b> tab.</li>
      <li>Click <b>Submit review</b> to approve it or request changes.</li>
    </ul>
  </div>
  <main id="main-content">
${tocHtml}
${bodyHtml}
  </main>
  <footer>Generated by <code>node tracker.js</code> · <span data-updated-iso="${now.toISOString()}">${formatUpdated(now)}</span> · ${totalItems} PR${totalItems === 1 ? "" : "s"} across ${groups.length} author${groups.length === 1 ? "" : "s"}</footer>
</div>

<button class="back-to-top" id="backToTop" type="button" aria-label="Back to top" title="Back to top">↑</button>

<script>
  // "Updated" timestamps are baked in at build time in the CI runner's
  // timezone (UTC); re-render them here so visitors see their own
  // machine's local time instead.
  document.querySelectorAll('[data-updated-iso]').forEach(function(el){
    el.textContent = new Date(el.getAttribute('data-updated-iso')).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  });

  function toggleTheme(){
    const r = document.documentElement;
    const cur = r.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', next);
    try { localStorage.setItem('docsPrTrackerTheme', next); } catch (e) {}
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
