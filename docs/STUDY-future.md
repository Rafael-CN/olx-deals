# garimpo-olx — where to take it next

A study of the tool's future, written from six specialist research passes, an adversarial
review of each, and a verification pass against `feat/olx-brasil` at commit time. Every
claim below is either (a) reproduced against the code in this repo, (b) carried with a
citation, or (c) explicitly labelled **judgement**. Where a specialist and the reviewer did
not converge, section 4 says so rather than picking a winner.

Ground rules inherited from the project and honoured throughout: personal non-commercial
use, no anti-detection of any kind, LGPD applies to seller data, honest failure beats
unreliable success.

---

## 1. Executive summary

### 1.1 `--queries` does not work, and it has never worked

This is the most important thing in the document and it appears in none of the six research
passes. It is a measured fact, not an argument.

`planShards` (`src/collect/shard.ts:196-199`) loops over `allQueries(profile)` and plans a
shard tree per phrasing, tagging each slice with `query`. But `shardKey()`
(`src/collect/shard.ts:37-40`) is built from `state | category | minPrice | maxPrice` and
**omits `query`**. The `shards` table has no `query` column
(`src/store/db.ts:36-50`), its primary key is `(run_id, key)`, and `saveShards` does
`ON CONFLICT(run_id, key) DO UPDATE SET total_count = excluded.total_count`
(`src/store/db.ts:213-215`). Then `sweep()` rebuilds each slice from the stored row without a
query (`src/collect/runner.ts:298-303`), so `filtersFor` falls through to
`shard.query ?? profile.query` (`src/collect/runner.ts:86-89`) — the primary query.

Reproduced on this branch with a stub probe:

```
planned shards: 3
  key= "rs|all||"  query= redmagic 10 pro
  key= "rs|all||"  query= nubia redmagic 10
  key= "rs|all||"  query= red magic 10 pro
distinct keys: 1 -> shards table rows after saveShards: 1
```

Three phrasings, three probe requests spent, **one** surviving shard row, swept under the
primary query alone. The surviving `total_count` is whichever phrasing happened to be planned
last, and that number drives `lastPage`, so the page budget for the sweep is set by a
phrasing that is never run.

`skill/SKILL.md:165-179` instructs the operator to compose 3–6 phrasings and reports a
measured result — "4 frasagens nacionais custaram 8 requisições e trouxeram 191 anúncios".
The 8 requests were the probes. The 191 ads came from one phrasing. The tool's headline
multi-query feature costs requests and returns nothing extra.

Two research proposals rest on this being false and must be re-read in its light: the
matching pass argued fuzzy title matching is a cheap substitute for extra phrasings (the cost
comparison was never actually measurable), and the agent-UX pass proposed a generated
coverage sentence that would have asserted "com 3 frasagens" in the tool's own voice.

### 1.2 The robots.txt checker is structurally incapable of seeing OLX's rules

`isDisallowed` (`src/collect/robots.ts:57-63`) strips trailing `*` and does `startsWith`, so
the rule `/*?*q=*` becomes the literal prefix `/*?*q=` and matches no real path. `parseRobots`
never reads `Allow` at all. The call site strips the query string before matching
(`src/cli/index.ts:596-598`, `new URL(...).pathname`). Meanwhile
`https://www.olx.com.br/robots.txt` disallows `/*?*q=*`, `/*?*ps=*`, `/*?*pe=*`, `/*?*o=*`,
`/*?*sf=*` and `/*?*sp=*` under `User-agent: *` — which are exactly and only the parameters
`src/scrapers/olx/domain-config.ts:93-108` emits (`q`, `ps`, `pe`, `o`, `sf`, `sp`).

So the tool checks robots.txt, finds nothing, says nothing, and the operator reasonably infers
"allowed". For a project whose differentiator is honesty, silently reporting a clean check
where the site said no is the most expensive defect in the collection path. There is also no
`Crawl-delay` anywhere in that file, so `rpmCeilingFor` never fires and the run's rate is
entirely self-chosen — which the CLI also does not say. ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html);
[Google retired Crawl-delay support, 2019](https://developers.google.com/search/blog/2019/07/a-note-on-unsupported-rules-in-robotstxt))

Separately and worth writing down next to it: OLX's Terms clause 9.2 prohibits "Realizar web
crawling no Site" ([Termos e Condições, 27/02/2025](https://ajuda.olx.com.br/public/Termos_e_Condicoes_de_Uso_OLX_27022025_727855f932.pdf)),
and there is no sanctioned read alternative — the public
[Ad Integration API](https://developers.olx.com.br/anuncio/api/home.html) covers an
advertiser's own ads only, no search, no cross-advertiser listings. Fixing the matcher does
not decide what the owner does; it makes the decision visible instead of hidden.

### 1.3 Several stored and printed numbers disagree with the numbers actually computed

Four independent instances, all cheap to fix, all corrosive to a tool that sells measured
claims:

- `runGems` persists `median: overall.median` — the corpus-wide median — on every `gems` row
  (`src/cli/index.ts:236`), beside a `discount_pct` and `robust_z` computed against that ad's
  **cohort** median (`src/triage/gems.ts:110-113`). Any later SQL over the `gems` table
  silently mixes two references.
- The same call writes `referenceSize: assessment.cohortSize` (`src/cli/index.ts:237`), which
  is `cohort.members.length` **including members with no price**, while the reference actually
  used was `buildReference`'s priced-only count. The stored evidence count overstates the
  evidence.
- `chooseCohort` accepts a stratum on `members.length >= minSize` over facts whose `price` is
  optional (`src/triage/taxonomy.ts:169-172`), then `buildReference` filters to finite positive
  prices (`src/triage/gems.ts:55-58`), so `assessGem` can reject at `:117` with "only 9
  comparable ads" on a cohort the selector had already approved at 12.
- `--sample-by spread` is documented as "stratified across price bands, so a small sample
  still shows the market's shape" (`README.md:131-133`, `skill/SKILL.md:142`), but the SQL is
  `ORDER BY CAST(a.price / 250 AS INTEGER), r.match_score DESC LIMIT ?`
  (`src/store/db.ts:441`) — ascending bands with a limit, i.e. the cheapest bands only. It is
  not stratified.

---

## 2. Where the tool is weakest today, evidenced

| Area | Problem | Evidence | Severity |
|---|---|---|---|
| Multi-query sweep | `--queries` phrasings collide on one shard key and are swept as the primary query | `src/collect/shard.ts:37-40` vs `:196-199`; `src/store/db.ts:36-50,213-215`; `src/collect/runner.ts:298-303`; reproduced above | critical |
| robots.txt | Wildcard/`Allow` unsupported, query string discarded before matching, so every disallowed sweep URL reports clean | `src/collect/robots.ts:17-63`; `src/cli/index.ts:596-604`; live robots.txt | critical |
| Gem provenance | `gems.median` is corpus-wide, `discount_pct` is cohort-relative; `reference_size` counts unpriced members | `src/cli/index.ts:232-238`; `src/triage/gems.ts:110-113` | high |
| Run/profile binding | `startRun` never replaces `profile_json`, so `enrich --profile v2 --run <id>` samples under v2 and judges under v1 | `src/store/db.ts:169-175`; `src/cli/index.ts` enrich branch vs triage/gems branch | high |
| Title matching | Substring token matching: `pro` matches `promoção`, `10` matches `10s` | `src/triage/match.ts:53-57`; executed below | high |
| Evaluation | No labels, no metric, no held-out set anywhere in the repo | grep over `src/`, `tests/` | high |
| Price history | `saveCards` overwrites the ask (`price = COALESCE(excluded.price, ads.price)`), so no price change has ever been recorded | `src/store/db.ts:312` | medium |
| Recourse & risk | Fraud enters gem scoring only as a price floor; cross-seller photo clusters are printed but feed no verdict | `src/triage/gems.ts:136-145`; `src/cli/index.ts` `logGemOutcome` | medium |

Title matching, executed against `src/triage/match.ts` on this branch:

```
93 | iPhone 13 128GB promoção imperdível <- iphone 13 pro
93 | iPhone 13 128gb pronta entrega      <- iphone 13 pro
100 | iPhone 13 Pro 128GB                <- iphone 13 pro
93 | Nubia Redmagic 10S Pro 512GB        <- redmagic 10 pro
39 | Red Magic 10 Pro 512GB              <- redmagic 10 pro
39 | Redmagc 10 Pro 512gb                <- redmagic 10 pro
67 | Xiomi Redmi Note 13 Pro             <- xiaomi redmi note 13 pro
```

A wrong phone scores identically to a right one (93), and a correctly-spelled listing with the
brand spaced scores 39. Note the code comment at `:53-55` justifies substring matching on two
cases — `pro`/`pró` and `512gb`/`512GB/16GB` — that the repo's own `tokenise()` already
handles, because accent folding produces a standalone `pro` token and `/` is a token
separator.

---

## 3. Ranked roadmap

Ordering rule: certain-and-cheap before speculative-and-expensive, and anything that makes the
tool assert something false ranks above anything that makes it smarter.

### 1. Make `--queries` actually sweep — or delete it

**What.** Add `query` to `shardKey()` (`src/collect/shard.ts:37`), add a `query TEXT` column to
the `shards` table with the primary key becoming `(run_id, key)` where the key now encodes the
phrasing, carry `query` in `saveShards`/`pendingShards`, and reconstruct it into the `slice`
object in `sweep()` (`src/collect/runner.ts:298-303`). Add a regression test asserting that N
phrasings produce N shard rows and that each sweeps its own phrasing. Then re-measure the
SKILL.md claim at line 179 and correct it.

**Why.** Reproduced above: today three phrasings collapse to one row and one phrasing is swept.
The feature is documented, costs one probe per phrasing, and delivers nothing. Everything
downstream that claims corpus coverage is currently overstating it.

**Effort** hours · **Impact** transformational · **Depends on** nothing
**Risk.** Fixing it makes nationwide multi-phrasing runs genuinely more expensive than they are
today — the cost was hidden by the bug, not absent. `estimate.ts` must be re-run against the
corrected plan before the skill's cost guidance is trusted. If the owner decides the extra
phrasings are not worth the requests, the honest alternative is to delete `--queries` rather
than leave it inert.
**Citations.** measured-in-repo; `skill/SKILL.md:165-179`

### 2. An RFC 9309 robots matcher, and a CLI that says what it found

**What.** Rewrite `src/collect/robots.ts` to match path **plus query string**, support `*`,
`$`, `Allow`, and longest-match-wins with `Allow` breaking ties; treat a 5xx on robots.txt as
full disallow; cache with a 24h ceiling. Fix the call site (`src/cli/index.ts:596-598`) to stop
discarding the query. Escalate the response from a line in `notes[]` to a blocking warning that
names the matched rule, with one explicit opt-in flag to proceed. Put the ToS clause and the
absence of a sanctioned read API in `README.md` beside it. While rewriting, drop the latching
group bug in `parseRobots` (`inScope = sawAnyGroup && inScope ? inScope || matches : matches`
merges a later non-matching group's rules into an already-entered `*` group — harmless on
these two files only because `*` is last).

**Why.** Section 1.2. The current checker cannot express the rules OLX actually publishes.

**Effort** days · **Impact** transformational · **Depends on** nothing
**Risk.** An honest matcher will report that essentially every sweep URL is disallowed, which
will read as "the tool broke". It did not; it is the first accurate report it has produced.
Four corrections the research got wrong and that must not reach the code: (a) both `Allow:`
lines on `rs.olx.com.br` sit inside a `User-agent: facebookexternalhit` group, so implementing
`Allow` changes **no verdict here** — do it for protocol correctness, do not sell it as a
behaviour change; (b) per-origin evaluation would *loosen*, not tighten, since the subdomain's
`*` group is a strict subset of `www`'s; (c) "refuse in `hunt`, allow in `plan`" is incoherent
because `plan` calls `makeProbe`, which fetches the same disallowed URLs
(`src/cli/index.ts:621`); (d) an opt-in override makes the tool a deliberately *worse-behaved*
client — frame it as "the owner overrides a stated request", not as a feature. It is not
evasion (robots.txt is not an access control), but it is a values call that belongs to the
owner, stated plainly.
**Citations.** [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html);
[OLX Termos 27/02/2025 cl. 9.2](https://ajuda.olx.com.br/public/Termos_e_Condicoes_de_Uso_OLX_27022025_727855f932.pdf);
[OLX Ad Integration API](https://developers.olx.com.br/anuncio/api/home.html); measured-in-repo

### 3. Four numbers the tool reports that it did not compute

**What.** (a) Store the cohort median on each `gems` row instead of `overall.median`
(`src/cli/index.ts:236`), and add a `cohort_level` column so a stored row is self-describing.
(b) Store `reference.size`, not `cohortSize`, in `reference_size` (`:237`). (c) Pass a
priced-only predicate into `chooseCohort` so a stratum is not accepted at 12 and then rejected
at 9 (`src/triage/taxonomy.ts:169`). (d) Either make `--sample-by spread` a genuine stratified
sample (a window function picking N per band) or change `README.md:131-133` and
`skill/SKILL.md:142` to say "cheapest bands first".

**Why.** Each is a claim the code does not support, in a tool whose value proposition is that
its claims are measured. (a) and (b) corrupt anything read back from the `gems` table; (d) is a
straight documentation/implementation contradiction.

**Effort** hours · **Impact** high · **Depends on** nothing
**Risk.** (a) changes stored values, so any saved SQL over `gems` needs re-reading. Minimal
otherwise.
**Citations.** measured-in-repo

### 4. Bind the run to the profile that judged it

**What.** `startRun` is `ON CONFLICT(id) DO UPDATE SET status = 'running'`
(`src/store/db.ts:169-175`) — `profile_json` is never replaced. `enrich` runs card triage
against the freshly-built CLI profile while `triage`/`gems` deliberately re-read the stored one
as authoritative, so `garimpo enrich --profile v2.json --run <id>` samples under v2 and judges
under v1. Fix: compute a canonical hash (sorted-key JSON, sha256) over the *decision-bearing*
fields only — `query`, `queries`, `demote`, `states`, `categories`, price bounds, `stages`,
`gems` — store it on `runs`, and have any phase carrying `--run` compare and refuse with a
field-level diff plus a named way forward (`--amend-profile`, or a fresh run id).

**Why.** The documented loop actively walks into this: `skill/SKILL.md:280` tells the agent to
take the `--demote` that `insights` suggested and run again. Silent scope drift is the failure
class this tool exists to avoid.

**Effort** days (hours, if the one-line fix is taken) · **Impact** high · **Depends on** nothing
**Risk.** **Do not put `sampleBy` or `minMatchScore` in the hash.** Those are exactly the knobs
the documented iteration turns between enrich passes (`enrich --run <id> --sample 200
--sample-by price` is additive and harmless — `src/collect/runner.ts:415-425`), and hashing
them converts normal use into an exit code. Consider first whether the one-line fix — have
`startRun` also `SET profile_json = excluded.profile_json` behind an amend flag, or have every
phase read the stored profile the way `triage`/`gems` already do — is enough, and say why if it
is rejected. Also note the enrich log line already prints the sampling policy in force, so
"with no message" overstates the current silence.
**Citations.** measured-in-repo; [MAST failure taxonomy](https://arxiv.org/abs/2503.13657)
(incomplete verification 6.82%, loss of conversation history 3.33%)

### 5. Whole-token title matching

**What.** In `src/triage/match.ts`, replace `haystack.indexOf(token)` with membership in a token
**set** built from the title using the same `tokenise()` the query uses. Keep `normalise()`,
the 0.88 coverage scale, the phrase bonus, the in-order bonus and `--demote` exactly as they
are. For the concatenation case (`RedMagic10Pro`), use **segmentation**, not substring: a title
token covers query tokens only if it splits entirely into them.

**Why.** Executed in section 2: `pro` ⊂ `promoção` and `10` ⊂ `10s` put wrong products at the
same score as right ones. The two cases the code comment cites as justification are both
already handled by `tokenise()`.

**Effort** hours · **Impact** high · **Depends on** nothing; pairs with #8 (`rescore`) so
existing corpora can be re-scored for free
**Risk.** **Do not ship the "unmatched query token may match as substring at 0.5 weight"
fallback that the research proposed.** Computed against the repo's own weights, it restores
`Nubia Redmagic 10S Pro 512GB` to 92% coverage and `iPhone 13 promoção` to 86% — both still top
band — and it re-blurs exactly the digit tokens that must never blur. Prefix matching does not
rescue it either: `'promocao'.startsWith('pro')` is true. Adopt instead the global rule that
**tokens containing digits match exactly, never approximately**. Re-scoring changes stored
numbers, so any threshold in a saved profile shifts meaning; print a before/after band
histogram (`store.matchScores` already supports it).
**Citations.** measured-in-repo (executed);
[Robertson & Zaragoza, BM25 and Beyond](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)
for the IDF direction, which belongs in #8 and **not** in the collection path

### 6. A label + eval loop, before any further matcher work

**What.** A `labels(ad_id, product_key, relevant, note, labelled_at)` table and two
zero-request commands: `garimpo label --run <id> --n 200` (stratified draw across the match
bands the histogram at `src/store/db.ts:549-562` already defines, y/n/skip) and
`garimpo eval --run <id>`, reporting precision@k for k ∈ {20, 50, 100} and — the number that
decides things here — how many labelled-relevant ads would and would not have been enriched
under each scorer variant given `maxDetails`. Register scorers behind `--scorer current|token|idf`.

**Why.** There is no labelled set, no metric and no held-out data anywhere in the repo; the
match tests are assertions about eight hand-picked titles. Every claim in this document about
what a matcher change *would* do is an argument, not a measurement, and 200 labels over a
corpus already on disk is an afternoon at zero requests.

**Effort** days · **Impact** high · **Depends on** #5 (so there is a second variant to compare)
**Risk.** **Key labels on `(ad_id, product_key)`, not `run_id`.** Relevance is a property of the
ad and the product; keying on the run means next week's re-sweep gets a new id and the
afternoon's labelling dies — which is how an eval harness stops being run. And **recall cannot
be computed unweighted from a band-stratified sample**: 40 labels from a 0–24 band holding
4.000 ads and 40 from a 90–100 band holding 60 are not interchangeable rows. Store the stratum
and its corpus size per label and use Horvitz–Thompson weighting for anything corpus-level;
report precision@k unweighted (it is a property of the ranked prefix) and label the two
differently in the output. Refuse to print metrics below ~50 labels.
**Citations.** measured-in-repo;
[WDC Products benchmark](https://arxiv.org/abs/2301.09521) for the fix-the-benchmark-first
discipline

### 7. Stop destroying price changes

**What.** `saveCards` does `price = COALESCE(excluded.price, ads.price)`
(`src/store/db.ts:312`) and `saveDetail` does `price = excluded.price` (`:390`), so a price cut
overwrites the old ask with no trace and no price change has ever been recorded. Add
`ad_price_history(ad_id, observed_at, price, source)` written only when the price differs from
the last stored value — one row per actual change, not per sighting. Surface it descriptively
in `reasons`: "opened at R$ X, cut twice, now R$ Y".

**Why.** It is one table and one field, it costs no requests, and a price cut between sweeps is
a self-evident signal that needs no model behind it.

**Effort** hours · **Impact** medium (high once re-sweeps are routine) · **Depends on** nothing,
but pays nothing until the same profile is swept twice
**Risk.** **Do not add a `negotiability` weight to `assessGem`.** A cut already lowers
`candidate.price`, which already raises `discountPct` and `robustZ` — scoring the cut again
double-counts it. And Knight's finding cuts against the proposed reason string: the sellers who
revise are the ones who *started too high*, so "18% below its own opening price" measures the
seller's original mispricing, not the buyer's opportunity. The cohort median is the right
denominator; the ad's own opening price is the contaminated one. Present cut history as context
for the human, not as score.
**Citations.** measured-in-repo;
[Knight (2002), *Listing Price, Time on Market, and Ultimate Selling Price*](https://onlinelibrary.wiley.com/doi/abs/10.1111/1540-6229.00038)
(38.4% of listings revised at least once; revisers are the high-initial-markup sellers)

### 8. `garimpo rescore` — the zero-request feedback loop

**What.** `garimpo rescore --run <id> [--demote 'a,b'] [--min-match N] [--dry-run]`, contacting
no site: read `ads.title` for the run, call `scoreBestMatch`, `UPDATE run_ads SET match_score,
match_json`, and print the band histogram before and after plus how many ads cross
`minMatchScore` in each direction. Have `insights` print the exact command rather than the flag
to remember. This is also where corpus-derived IDF weighting belongs, if it is wanted at all —
computed once over a complete corpus, never inside `scoreListings`.

**Why.** `insights` derives a `--demote` suggestion from OLX's own `Marca`/`Modelo` fields and
`skill/SKILL.md:280` tells the agent to feed it back — but scores are written only at
collection time (`src/collect/runner.ts:16-35`), so acting on the suggestion today means
re-collecting: hundreds of requests to apply a local string change.

**Effort** hours · **Impact** medium · **Depends on** #5 (there must be something worth
re-scoring), #4 (the rescore should be recorded as a profile amendment)
**Risk.** The research called this "the schema forbids it" — it does not. The
`MAX(run_ads.match_score, excluded.match_score)` upsert (`src/store/db.ts:319-324`) lives
inside `saveCards`; a rescore writes with an `UPDATE` and never touches it, so no
`score_epoch` column is needed for rescore to work. The epoch is needed for a *different*,
real defect: a subsequent `collect` on the same run re-seeing a card restores its
pre-demotion score. Fix that separately and say it is a collect-side amendment. Also add
`rescore` to the read-only command list at `src/cli/index.ts:399` deliberately — it writes.
IDF over a query-conditioned corpus measures "rare among what this query returned", which is
the right thing for down-weighting `samsung` and nothing more; say so in the code.
**Citations.** measured-in-repo;
[Anthropic, skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
("Implement feedback loops")

### 9. Route `Retry-After` to the cooldown regardless of status

**What.** `looksBlocked` matches only 403, 429 or the Cloudflare body text
(`src/collect/fetcher.ts:234-237`), and `src/collect/runner.ts:149-150` sends everything else
≥ 400 to `reportError()` — a flat 0.85× that never reads `Retry-After`, since only
`reportBlocked` does (`src/collect/governor.ts:141-149`). So a 503 with `Retry-After`, the
standard way a server asks for a pause, is handled *worse* than a 429. Route any `Retry-After`
to the cooldown whatever the status, and decide deliberately whether 503 should enter
`looksBlocked`.

**Why.** It is the one change in the pacing area that is mechanically sound, cheap, and
unambiguously makes the client better behaved — which is the axis the hard constraint names.

**Effort** hours · **Impact** medium · **Depends on** nothing
**Risk.** Almost none. `governor.test.ts` injects `sleep`/`now`/`random` for determinism; keep
that discipline.
**Citations.** measured-in-repo; [RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html)

### 10. Split risk from bargain: a second column, never folded into the score

**What.** `src/triage/risk.ts` exporting
`assessRisk(candidate, context) → { band: 'low'|'elevated'|'high', points, flags }`, a plain
additive scorecard with weights as named constants — no model, no training. Flags built from
what already exists: cross-seller photo cluster, relist count, price under the plausibility
floor while `Condição` says Novo/Lacrado (a direct internal contradiction), zero or one photo,
very short description. Persist to a `risk` table, print risk **beside** the gem verdict, and
add `riskVeto: 'none'|'high'` to `GemConfigSchema` defaulting to `'none'`. Pair it with
`garimpo label <adId> <outcome>` writing an `outcomes` table
(`contacted|no-reply|met|bought|vanished|scam-attempt`), and `garimpo insights --risk`
reporting raw flag hit counts against labelled outcomes.

**Why.** "Will I get a bargain" and "will I get the item" are different questions with different
actions, and `assessGem` multiplies them into one `score`. Fraud enters gem scoring only as the
price floor, and the cross-seller cluster — the tool's most fraud-relevant computation — is
printed as advisory text and affects no verdict.

**Effort** days · **Impact** medium–high · **Depends on** nothing for the flags that use stored
data; the escrow/advertiser-type flags depend on the measurement in #12
**Risk.** Below ~50 labels nothing is significant; report **counts, not rates**, or the tool
starts making exactly the plausible-but-unmeasured claim the owner rejects. Treat the flag list
as the deliverable and the weights as provisional, and prefer flags checkable by eye ("this
photo also appears in ad X") over flags that are only a number. Note that the seller-gate half
of this proposal is **already built and already decided in the same direction**: `gemHuntPreset`
has no `minRating`, and the comment at `src/config/profile.ts:503-506` explains that adding
`minAccountAgeMonths`/`minRating`/`minReviewCount` forces a ~60-request page load, so they are
opt-in. What survives is only the narrow claim that *when* a rating is present, 0.30 is heavy
relative to the cancellation record. LGPD: the outcomes table records interactions with
identifiable sellers — keep the note field free of third-party personal data, and cover it by
the retention command in #11.
**Citations.** measured-in-repo;
[Hand & Henley (1997), consumer credit scoring review](https://www.jstor.org/stable/2983268)
for interpretable additive scorecards;
[Filippas, Horton & Golden, *Reputation Inflation*](https://pubsonline.informs.org/doi/abs/10.1287/mksc.2022.1350)
— suggestive by analogy only, since it studies a bilateral online **labour** market, not
used-goods seller ratings

### 11. LGPD hygiene: drop what is not needed, retain what is on a clock

**What.** Three concrete things. (a) `SellerInfo.phone` is persisted verbatim inside
`ad_details.seller_json` — a direct personal identifier held on disk indefinitely. Drop it at
parse time unless a configured gate needs it. (b) Add `garimpo forget --older-than 180d` and
`--sellers`, purging seller fields and any behavioural tables. (c) Put the position in
`README.md`, which today contains no LGPD text at all: Art. 4º I exempts processing by a
natural person for exclusively private and non-economic purposes, and that exemption is what
keeps this corpus out of scope — it ends the moment the database is shared, published or used
commercially.

**Why.** The exemption is purpose-bound, not content-bound, so the right engineering response is
minimisation plus retention, not a consent flow. Necessity (Art. 6º III) argues for storing
less than the parser happens to find.

**Effort** hours · **Impact** medium · **Depends on** nothing
**Risk.** State Art. 4º I as **the owner's reading**, not as settled scope — a tool whose
purpose is to secure a financial advantage in a purchase is at least arguably economic, and the
research overstated this as established. Do **not** adopt the proposed salted-hash contact
table: `ad_details.description` is stored in plaintext and the phone numbers are already in it,
so hashing an extracted copy while leaving the source beside it in the same table achieves
nothing, and a salted SHA-256 over a ~10¹⁰ phone-number space with the salt in `dataDir` is
pseudonymisation, not anonymisation. Either redact at the source or do not pretend to.
**Citations.** [Lei 13.709/2018 (LGPD)](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
Art. 4º I, Art. 6º III, Art. 12;
[ANPD Radar Tecnológico nº 3](https://www.gov.br/anpd/pt-br/assuntos/noticias/ia-generativa-e-tema-do-3o-volume-da-serie-radar-tecnologico-da-anpd)
(scraped public data is still tratamento de dados pessoais)

### 12. The measurement backlog

Seven cheap measurements, each of which gates a proposal that is otherwise unbuildable or
unjustifiable. Run them, record the results in the repo next to the existing MEASURED FACTS,
and only then decide. None of them is a feature; all of them are the difference between a
measured claim and a plausible one.

| Measurement | Cost | Gates |
|---|---|---|
| Does `garimpo gems` ever meet a zero-MAD cohort? `SELECT price, COUNT(*) FROM ads GROUP BY price ORDER BY 2 DESC` | zero requests | the entire MAD-escalation proposal — if it never happens, that work is a no-op |
| Interstate price spread: median and n per UF over the enriched corpus, as an `insights` block | zero requests | whether geography needs to be in valuation at all, and whether that is one more `COHORT_LEVELS` rung or a regression |
| Enriched-sample cohort median vs card-corpus median restricted to high-match ads, per cohort | zero requests | whether the price-ordered enrichment sample actually biases the reference, and in which direction |
| Contact base rate: run a phone/e-mail/handle extractor over `ad_details.description` | zero requests | whether off-platform steering is a signal or a near-universal habit |
| Ads-per-seller distribution over the existing store | zero requests | whether a `/perfil/` seller cache is a 60× win or a 1× win |
| Re-sweep the same profile twice within a day; what fraction of ads vanish with no plausible sale? | one sweep | whether any survival/disappearance analysis is buildable at all |
| Do OLX ad documents carry `ETag`/`Last-Modified`/`Cache-Control`? Three ad documents plus one search document through the tool's own session | 4 requests | whether conditional requests are worth any schema at all |

While doing the last one, fix the adjacent lie: `fromCache` is a hardcoded `false` inside the
page-evaluated fetch (`src/collect/fetcher.ts:95,103`), so `this.cached` never increments and
`stats.cached` is structurally always 0 — directly under a comment describing how a cache hit
*could* be detected. And the fetcher docstring claims a page unchanged since a previous run "can
come back as a 304 or not leave the machine at all", which `session.ts:72-78` makes impossible:
the context is `browser.newContext()` with only `storageState` persisted, so the HTTP cache dies
with the run. A false comment in the most-read file of the collection path is a trap.

**Effort** hours each · **Impact** high in aggregate · **Depends on** nothing

---

## 4. Explicit disagreements

These are open. The reader should not treat any of them as settled by this document.

**4.1 Which pool should the price reference come from?**
The valuation pass showed the reference is built from `store.detailsFor(runId)` — the enriched
set, capped at `maxDetails` (default 400) and ordered by `sampleBy`, where `price` is
`a.price ASC` and even the default `match` tie-breaks on `a.price ASC`. Its fix was to build
scale from the whole card corpus. The reviewer objected that the card corpus is unlabelled
*and* the search is fuzzy — 191 nationwide results for "redmagic 10 pro" contain ~15 real ones
— so broadening the pool trades selection-on-price for roughly 12:1 product-mix contamination.
**Open question:** the third row of the measurement backlog answers it directly, at zero
requests. Do not build either estimator first.

**4.2 Which way does the stock/flow bias point?**
The temporal pass argued the live-listing stock over-represents slow-selling, over-asked ads,
so the median is too high and every discount is overstated. The reviewer noted the same
specialist's own third finding says list prices *fall* over an ad's life — so a flow reference
built from newly-seen ads is composed of un-cut opening prices, the highest in each ad's life.
The two mechanisms push opposite ways and neither has been measured.
**Open question:** report both medians side by side as a diagnostic with the ratio labelled
"sign unknown", and do not switch what `assessGem` judges against until the corpus says which
way it goes. Separately: `shard_coverage` keyed on the generated shard key cannot work, because
`planShards` re-splits adaptively and every re-split renames the key.

**4.3 Should the gate open or close on a zero-MAD cohort?**
`src/triage/gems.ts:184` reads `reference.mad === 0 || base.robustZ >= config.minRobustZ`, so
the spread gate opens when MAD collapses. The specialist called this an inversion. The reviewer
observed that the limit of `(median − price)/MAD` as MAD → 0 is +∞ for any price below the
median, so opening is the defensible limiting behaviour. Both readings are coherent.
**What is not in dispute:** `robustZ` is reported as `0.0` in the printed reason
(`src/triage/gems.ts:114,186-190`) while the verdict says `gem`, so the explanation string
asserts the ad sits at the median. That is an honesty bug regardless of which side wins, and
the fix is to emit "no measurable spread in this cohort — discount alone decided this verdict".

**4.4 Does excluding the subject from its own cohort matter, and in which direction?**
The specialist said self-inclusion "shifts the median in the direction that flatters it". The
reviewer's arithmetic is the other way: a cheap subject included in its own cohort *lowers* the
median, which *shrinks* `discountPct` and `robustZ`. Self-inclusion makes the tool conservative,
so leave-one-out is a correctness cleanup rather than a false-positive source — which also means
it does not need to ship alongside shrinkage and confidence intervals.

**4.5 Are fuzzy matching and extra phrasings substitutes or complements?**
The matching pass framed local fuzzy matching as buying the same coverage as extra `--queries`
for free. The reviewer called it a category error: extra phrasings change *retrieval* (which
rows exist), fuzzy scoring changes *ranking* (among rows already collected), and a title OLX
never returned cannot be recovered by any local string metric. Section 1.1 settles the cost half
of the argument in the reviewer's favour and then some — the "4 phrasings cost 8 requests"
measurement the specialist cited was measuring probes for phrasings that were never swept.

**4.6 Should the tool offer a flag to proceed against robots.txt?**
Reporting honestly is unambiguously right. Whether to ship an override is a values call: it is
not evasion and robots.txt is not an access control, but it does make the client deliberately
worse-behaved on an axis the project otherwise optimises. This document recommends the flag
exist and be framed as an override of a stated request. The owner may reasonably decide
otherwise.

---

## 5. What could not be sourced, and therefore rests on judgement

- **Brazilian regional price levels for used electronics.** No source found. The guess that
  interstate spread is 10–20% is unsupported; the measurement backlog tests it for free.
- **OLX-specific listing dynamics.** Nothing published on how olx.com.br ranks, how often asks
  are cut, or what fraction of listings sell rather than expire. The nearest rigorous analogue is
  the housing days-on-market literature, and every transfer from it is inference — phones are
  standardised, search frictions are lower, and OLX's listing term is fixed at 30 days for
  Celulares ([OLX Ajuda](https://ajuda.olx.com.br/s/article/expiracao-e-renovacao-de-anuncios)),
  where housing listings are open-ended.
- **What an expired or removed OLX ad URL returns** (404 / 410 / 200-with-notice / redirect),
  whether renewal preserves the ad id, and whether the analytics `adDate` resets on renewal.
  All three are one-request measurements and all three gate any exit-time analysis.
- **Whether the escrow badge and "Tipo de anunciante" survive into server-rendered HTML.** A
  grep of the whole repo for `garantia`/`Entrega Fácil`/`Profissional`/`Particular` finds
  nothing in any fixture. The card fixture node the research cited
  (`src/scrapers/olx/html-path.test.ts:50`) carries `em até 10x sem juros` — installment
  financing, a different field.
- **Whether `/perfil/` server-renders `memberSince` and `rating`.** Cloudflare 403s a plain HTTP
  client on HTML, so this could not be checked from outside the tool's own session.
- **Whether faceted browse paths paginate without the disallowed `o=` parameter, and whether a
  facet path's result set matches the equivalent `?q=` search.** Unmeasured, and the whole
  sitemap-sharding idea depends on it.
- **The 46/28/15/10% split of OLX fraud types and the 27% celulares figure.** These come only
  from press coverage of an OLX-run internal survey with no published methodology
  ([O Tempo](https://www.otempo.com.br/economia/2025/2/10/levantamento-da-olx-mostra-prejuizo-de-r-3-5-bi-de-brasileiros-com-fraudes-em-compras-online)).
  Directional at best; nothing in this roadmap depends on the numbers.
- **The "~9% of Craigslist scam listings were clones" figure.** Absent from every accessible
  version of the source; the specialist did not read the paper. Do not repeat it.
- **The mobile.de "69% reduction in fraudulent-listing exposure" figure.** Taken from a
  search-result snippet of a paper behind a 403. Do not repeat it.
- **Whether under-ranked listings on a classifieds site are actually priced below comparable
  well-titled ones.** This is the tool's founding hypothesis and it has never been tested. The
  eval harness (#6) is the instrument that would test it.

---

## 6. Rejected proposals

### Rejected because the code already says otherwise

- **"`minRobustZ` is mis-scaled — apply the 1.4826 consistency constant or rename the knob."**
  `src/config/profile.ts:377-386` documents it as "Distance below the median in robust units —
  (median - price) / MAD", which is character-for-character what `gems.ts:114` computes, and the
  CLI prints "1.5 MAD", not "1.5 σ". Nothing is mis-documented. The proposed rename is a rename
  to what it already means, and the accompanying risk note inverts the direction: multiplying MAD
  by 1.4826 enlarges the denominator and *tightens* the gate.
- **"Drop `minRating` from `gemHuntPreset` and stop paying 60 requests for a weak signal."**
  There is no `minRating` in `gemHuntPreset`. Its seller gate is
  `{ maxCancelRate: 0.5, onUnknown: 'pass' }`, and the comment directly above
  (`src/config/profile.ts:503-506`) already makes exactly this argument. Further,
  `scoreSeller` builds `parts` only from present fields and renormalises by their summed
  weight, so an unhydrated seller's rating weight does not exist — the tool never pays a
  request for rating unless the user opts into a rating gate.
- **"`report --json` returns unbounded arrays and no coverage statement."** `topGems` is
  `ORDER BY score DESC LIMIT ?` (default 15), `rejectionReasons` is hard-limited to 8, and the
  payload already carries `totalAds`, shard status counts, price range and a five-band match
  histogram. The genuinely unbounded JSON surfaces are `plan --json` and `insights --json` —
  retarget any capping work there.
- **"The gem cohort is corrupted by card-only ads mis-clustered as relists."** `runGems` builds
  `entries` from `detailsFor` (enriched only) while `duplicates` comes from all run ads, so
  card-only ads are filtered out of the pool before `duplicateAdIds` can matter. The real
  defect is narrower and still worth fixing: `classify()` cannot reach `cross-seller` when no
  member carries a seller name, so add an `unknown-seller` kind and exclude it from
  `duplicateAdIds()`.

### Rejected because the reasoning does not hold

- **Adjusted-boxplot lower fence replacing `implausibleBelowPct`.** The boxplot is an *outlier
  detector*; the ads this tool exists to find are lower-tail outliers by construction. On the
  repo's own fixture (`src/triage/gems.test.ts:18`: 2300…2800), p25 = 2450, p75 = 2600,
  IQR = 150, median = 2500, so even at MC = 0 the fence sits at 2225 — anything more than 11%
  below the median is "implausible", while `minDiscountPct` defaults to 0.30. Every ad that
  could ever be a gem falls below the fence. Working in log space changes the numbers, not the
  sign. The underlying error is conflating a *semantic* claim (a working phone does not sell for
  a quarter of the going rate) with a *statistical* one (this price is unusual for this cohort).
  Keep `implausibleBelowPct` as the hard override; if the binary verdict is to soften, use the
  three labels already computed in `runGems` (missing `Modelo`/`Memória interna`, an accessory
  hit in the demote lexicon, a cross-seller photo cluster) to say *why* an ad is suspect.
- **Latency-driven AIMD control.** AutoThrottle's premise is that response latency tracks
  *server load*. Behind Cloudflare, TLS terminates at the edge, latency is dominated by cache
  hit/miss, and the 403 being anticipated is a WAF decision keyed on rate, reputation and
  fingerprint — not origin load. There is no mechanism by which rising latency predicts that
  refusal. Ship latency as **instrumentation only** (log the EWMA and running minimum in
  `stats`), and check against real logs whether the correlation exists. If it does not, the
  honest outcome is "there is no cheap early signal here; the AIMD design is correct as it
  stands", which is itself worth reporting.
- **Excluding 304s from `cleanStreak`.** A 304 is a full origin round-trip: the server received
  the conditional, evaluated it and answered. It is the strongest available evidence the origin
  is willing to serve this client. Only a browser cache hit skips the origin — and per #12, the
  tool cannot currently detect one anyway.
- **Change-rate-proportional detail refresh, citing Cho & Garcia-Molina.** The paper's signature
  result is that the **proportional** policy is *worse* than uniform and can be wildly
  suboptimal; its optimal policy is non-monotonic and deliberately spends *less* on the
  fastest-changing documents ([TODS 28(4), 2003](https://dl.acm.org/doi/10.1145/958942.958945)).
  The citation argues against the proposal. Separately, the naive `λ̂ = changes/elapsed`
  estimator is biased low when the sampling interval is long relative to the event — which it is,
  with a 7-day floor. Add the `checks`/`changes`/`last_change_at` counters if desired, change no
  ordering, and look at the distribution before choosing a policy.
- **Kaplan–Meier / Aalen–Johansen survival on ad disappearance.** Cause is not observed; the
  proposal assigns it by a deterministic function of exit age, so feeding those labels into an
  estimator of incidence-by-time recovers only the rule that was put in. The rule table also has
  a hole (exits at age in `(term−5, term−2)` match no branch). What the data can honestly
  support is a plot of empirical exit hazard by age with the day-30 spike marked, used to
  *validate* the term table, plus one number: the fraction of exits before `term−5`, labelled
  "upper bound on sale probability".
- **"Clearing price" as what the market takes.** The quantity solved for is the *list price* at
  which a listing tends to disappear. Both numbers are asking prices; OLX transactions are
  negotiated off-platform and never observable. Under the same research pass's own negotiability
  argument, this "clearing price" sits *above* what buyers pay, by exactly the negotiation
  margin. Printing it beside the median as "what the market actually takes" is the specific
  failure mode this project cares most about avoiding.
- **Per-sweep Bernoulli detection probability estimated from revenants.** The cited detection
  failures on this corpus are *structural and persistent* — the tool runs the same phrasing list
  every sweep, so an ad no phrasing reaches is missed every time, not with probability 1−p. And
  estimating p̂ from revenants conditions on later re-detection, excluding exactly the long miss
  runs that terminate an observation string, which biases p̂ *high* and makes "gone" verdicts
  premature. If presence is to be tracked, record which query found each ad, so a miss can be
  attributed rather than modelled.
- **Perceptual-hash banding into four 16-bit bands.** At the stated Hamming threshold of 10/64,
  four bands guarantee recall only to distance 3 — pigeonhole says a distance-10 pair has at most
  one band with ≤2 errors. The index would silently miss most true matches. A linear scan with
  popcount over a few thousand cached hashes is the honest design, not the fallback. Also, "same
  image, new upload id" is not the clone signature: an honest seller who deletes and re-posts
  produces the identical signature.
- **Category-drift as an account-takeover flag.** The corpus is built from one product query, so
  by construction a seller's ads in unrelated top-level categories are not in the store. It is
  uncomputable without the per-seller listing fetch that the same proposal relegates to an
  optional extra.
- **10-minute publish-burstiness windows over card dates.** `parseCardDate`
  (`src/scrapers/olx/br-parsers.ts`) defaults hours and minutes to 0 for anything that is not
  "Hoje, HH:MM" / "Ontem, HH:MM", so every older ad lands at local midnight of its day. The
  window would fire on any seller with N same-day listings — honest shops especially.
- **`bandRetention` as a scope-error gate.** Retention of banded/unbanded raw counts is dominated
  by query fuzziness, not scope error: a *correct* band around the real product drops nearly all
  the accessories and neighbouring models, landing near 10% and tripping both proposed
  thresholds. It is a fuzziness meter. Compute retention over ads scoring ≥ `minMatchScore`
  instead, after a collect, at zero requests.
- **Refusing a bare `garimpo report` when more than one run started in 24h.** The tool's own
  rule mandates one target per run, so two runs in a day is correct usage, not ambiguity.
  `report` is read-only and free; print the run chosen and the alternatives instead.

### Rejected because it drifts toward evasion

- **Jittered timing within the working window to reduce pattern recognisability.** Proposed with
  the explicit rationale that a daily standing job "accumulates a recognisable pattern over
  months". Timing randomisation introduced to be less recognisable is disguise, whatever the
  following sentence calls it, and it is on the wrong side of the project's hard constraint. If
  timing variation is wanted, justify it as load-spreading and cap it explicitly — a fixed,
  small, predictable daily load is both the better-behaved option and the easier one to defend.

### Rejected as not worth it, or not yet

- **A local embedding model in the matching path.** Correctly rejected by the research itself.
  The discriminative content here is `s22` vs `s23` and `256` vs `512`, which is the exact class
  dense retrievers handle worst
  ([Sciavolino et al., EMNLP 2021](https://aclanthology.org/2021.emnlp-main.496/);
  [BEIR, NeurIPS D&B 2021](https://arxiv.org/abs/2104.08663)). The measured failure in this repo
  is a tokenisation bug and an inverted weighting, both fixable with string code. Revisit only if
  the eval harness shows a large residual of relevant ads no lexical variant recovers.
- **Hedonic quantile regression on log price.** Geography really is absent from valuation
  (`COHORT_LEVELS` is `['model+storage+condition','model+storage','model','all']` and
  `ads.location` never enters `buildReference`, `chooseCohort` or `assessGem`) — that part is
  correct and confirmed. But the design matrix can only be built from the same ≤400 enriched,
  price-ordered rows, `n` is ~250 with `p` ~40 once 27 UF dummies are added, and the proposal's
  own judgement note says the state effect is testable in an afternoon. Do the afternoon first;
  if the effect is large, one more `COHORT_LEVELS` rung preserves the legible "compared against
  14 ads of the same model and storage in RS" explanation that is one of this tool's real
  strengths.
- **Sitemap-driven facet sharding.** The vocabulary half is genuinely good and appears as future
  work: OLX publishes 29 sitemap directives and the per-state trees carry canonical
  brand/model/storage/condition slugs at paths carrying no query string, so no `?`-anchored
  disallow can match them. But the facet tree is a *combinatorial product*, not an inventory — a
  2010 Huawei handset appears enumerated across 64/128/256/512 GB — so emptiness is the dominant
  case and a naive planner spends one request per slice to learn "zero" across ~350k URLs for one
  state. And the benefit lands where the tool needs it least: facets exist for catalogued models,
  while the case that motivates the whole match-scoring apparatus ("redmagic 10 pro", 191 results
  of which ~15 are real) is precisely the model unlikely to have one. Harvest the vocabulary;
  defer the sharder behind the facet-density and pagination measurements in #12.
- **Shrinkage + median confidence intervals on thin cohorts.** A genuine days-scale project with
  the right instinct — the `minReferenceSize` cliff currently does shrinkage's job with a step
  function, and judging `discountPct` against the lower CI endpoint is the correct conservative
  direction ([Smith & Winkler, *The Optimizer's Curse*](https://jimsmith.host.dartmouth.edu/wp-content/uploads/2022/04/The_Optimizers_Curse.pdf);
  [Efron & Morris 1975](https://www.researchgate.net/publication/239061805_Data_Analysis_Using_Stein's_Estimator_and_Its_Generalizations);
  [Hettmansperger & Sheather 1986](https://www.sciencedirect.com/science/article/abs/pii/0167715286900210)).
  They must ship together or shrinkage alone increases false gems. Deferred behind #3, which
  fixes the concrete bugs in the same code at a fraction of the cost, and behind the reference-pool
  measurement in #12, which decides what the CI would even be a CI *of*.
- **Splitting SKILL.md into a spine plus references.** Defensible on recurring token cost — the
  file is 424 lines and stays in context across turns
  ([Claude Code skills docs](https://code.claude.com/docs/en/skills)). But `allowed-tools` does
  not solve the prompt-fatigue problem it was proposed for (the grant covers only the invoking
  turn, and a hunt is inherently multi-turn), the lost-in-the-middle argument is decoration ("um
  alvo, um run" is at line 86 of 424, under its own H2), and the flag table is not duplication of
  `--help` — it carries judgement `--help` does not. Worth doing eventually, against at least
  three real hunts as an evaluation, and after #1 changes what the skill should say about
  `--queries`.
- **Interview-after-measurement, and a cost-estimate gate.** The reordering half is good and
  cheap. The gate half cannot fire as specified:
  `totalRequests = Math.min(cardRequests + detailRequests + probesAlreadySpent, limits.maxRequests)`
  (`src/collect/estimate.ts:51-55`), so `totalRequests > maxRequests` is never true. The signal
  wanted already exists as `limitedBy === '--max-requests'`. And refusing on "plan exceeds budget"
  would refuse working behaviour: `newBudget` + `makeGate` already halt cleanly, save progress and
  print the resume command. Gate on an explicit consent threshold if at all, and make
  budget-exceeded a warning naming the resume command.

---

*Verification note: every `file:line` reference in this document was checked against
`feat/olx-brasil` while writing it, and the two code executions (match scores, shard-key
collision) were run in this repo. Where research findings and the review disagreed on a fact,
the repo was consulted and the result is stated above without hedging.*
