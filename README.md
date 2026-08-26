# garimpo-olx

Bulk collection and triage of [olx.com.br](https://www.olx.com.br) classified ads.

One command sweeps a product across Brazil, filters it through configurable triage
stages, and ranks what survives against the going rate for that product on OLX
itself — so a listing far below the median, in usable condition, from a seller with
a record, comes out on top.

Ships as a CLI plus a Claude Code skill. There is no MCP server: every useful run
here collects hundreds of ads, and routing that through tool calls would spend the
model's context on rows instead of on conclusions.

## Install

Needs Node 22 or newer (it uses the built-in `node:sqlite`) and a Chromium for
Playwright.

```bash
npm install && npm run build && npm link
```

```bash
npx playwright install chromium
```

Playwright's default headless mode needs a separate `chromium_headless_shell`
download, which is easy to end up without. The launcher tries the shell, then the
full bundled Chromium, then the system Chrome and Edge, and says which it used —
so a missing shell is not a hard failure. `--channel chrome` forces a choice.

## Use

```bash
garimpo hunt --query "galaxy s22 ultra" --states rs \
  --require 's\s*22,ultra' --reject 'capa,capinha,carregador,s21,s23,plus' \
  --min-price 800 --max-price 4000 --tolerate minor --gems --top 10
```

Better, for anything you might run twice — a profile is a record, shell history is
not:

```bash
garimpo template > perfil.json   # a full, editable profile including the defect lexicon
garimpo hunt --profile perfil.json
```

For a large sweep, run the phases separately so collection is not held hostage to
the slowest part:

```bash
garimpo plan    --profile perfil.json          # how the search will be sliced
garimpo collect --profile perfil.json --run <id>
garimpo enrich  --profile perfil.json --run <id> --max-details 100
garimpo gems    --run <id>
garimpo report  --run <id> --top 20
```

`garimpo --help` lists every flag.

## What OLX actually does, and why the design looks like this

Every constraint below was measured against the live site. They are the reason the
tool is shaped the way it is.

### Searches stop at 5.000 results

OLX pages 100 pages of 50 and no further. Page 101 does not error — it serves page
100 again, which is how a naive crawler reads the same 50 ads forever and believes
they are new. `q=iphone` nationwide reports over a hundred thousand results, so no
single query can reach it.

`plan` therefore cuts the search into slices that each fit under the ceiling,
probing before it splits: state first (27 ways, one request each), then category,
then price bands off a geometric ladder, then bisection of a band still too big.
A state with twelve matching ads costs one request and is never split.

### The path is `/<category>/<state>/<region>`, in that order

A category placed after a location is silently ignored — `/estado-sp/celulares`
returns every São Paulo ad, not just the phones. The tool only ever emits the order
that works.

### `sortBy` changes *which* ads come back, not just their order

Applying any sort makes OLX answer with a different result set:

| query (in `estado-rs`) | no sort | any sort |
| --- | --- | --- |
| `s22 ultra` | 71 | 7 |
| `galaxy s22 ultra 256gb` | 13 | 7 |
| `ultra` | 352 | **584** |

A sort can narrow the set or widen it, so this is not "sorting filters". Sweeps
always run unsorted, which is the widest set, and order locally.

### Search is fuzzy, so titles are scored, not filtered

Of 71 `s22 ultra` hits in Rio Grande do Sul, seven were actually S22 Ultras. The
rest were S22, S22+, S21 Ultra, S23 Ultra, cases and screen protectors.

The obvious response — require the words in the title — is a trap, and it cost a
real search: a nationwide hunt for "redmagic 10 pro" that OLX answered with 191
ads came back with two. So titles get a 0-100 match score instead, weighted by
token length so matching "redmagic" counts for four times matching "10", with a
bonus for the query appearing as one phrase and a heavy demotion for accessory and
sibling-model words. Nothing is dropped.

That matters beyond tidiness. A badly titled listing is *under-found by everyone*,
which is exactly why it can sit below the going rate. In the same run, the cheapest
ad scoring 90+ was R$ 3.000, while a listing titled just "Celular Redmagic" scored
70 at R$ 2.700. A hard filter deletes that ad; a score ranks it and lets you look.

`garimpo candidates` browses the ranked base, and the threshold moves afterwards
without spending a request:

```bash
garimpo candidates --run <id> --min-match 70 --max-price 3000 --top 20
```

### One query is what a person would type; a hunt runs several

`--queries` sweeps extra phrasings into the same run — "red magic 10 pro", "nubia
redmagic 10", "redmagic 10" — because OLX ranks on the words the seller happened
to type. The sets overlap heavily, so the union costs far less than the sum: four
nationwide phrasings cost 8 requests and returned 191 ads.

### Reading every candidate is optional

Collecting cards is 50 per request; reading an ad page is one each. `--sample N`
caps how many candidates get read and `--sample-by` picks which: `match` (best
answers), `price` (cheapest), `spread` (stratified across price bands, so a small
sample still shows the market's shape) or `random`.

### Cloudflare is the real bottleneck, and a browser is the wrong client

Blocks arrive as 403 across the whole domain, by IP. Everything about the
transport follows from that.

**Opening a page is not one request.** The document arrives, then the Next.js
chunks, then analytics, then the ad slots, then the page's own API calls — dozens
of hits, many to olx.com.br, for every ad read. Charging that as "one request" is
how a run that looks gentle gets rate-limited in a minute.

So the collector does not open pages. It fetches the document alone and renders it
in a second context with JavaScript disabled and every route aborted, which gives
the same selectors a real DOM for free. The search page server-renders all fifty
cards and the ad page server-renders its schema.org block, so this costs nothing in
coverage.

**And it fetches with Chrome, not with Node.** The fetch happens inside a page
already parked on the target origin, through the browser's own `fetch()` — Chrome's
TLS handshake, Chrome's header set, Chrome's cookie jar. Going through Node's HTTP
stack would send a different client from the one that earned the session's cookies:
fewer requests, each less coherent. Each origin is anchored on its own
`/robots.txt`, which is a few hundred bytes and a document a crawler should be
reading first anyway.

**Which gates you choose decides what the sweep costs.** The ad's HTML carries the
sales record and the verification badges, but not the seller's name, join date or
rating — those appear only once the card hydrates. Measured, not assumed:

| Seller gate | Cost per ad |
| --- | --- |
| `maxCancelRate`, `minSalesCompleted`, `requireVerified`, `requireChannels` | 1 request |
| `minAccountAgeMonths`, `minRating`, `minReviewCount` | ~60 requests |

A hydrated ad page was measured at roughly sixty requests to olx.com.br — the
document, the Next.js chunks, analytics, ad slots and the page's own API calls.
The seller's *name* comes free from the payload embedded in the markup; the join
date and rating are not in the document at all, arriving from a client-side call.

An ad is upgraded to a page load only when the cheap read came back missing a field
the configured gates will actually read. A profile with no seller gate never runs
JavaScript at all.

**A refused page still parses** — it just has no cards on it — so without a check
it reads as "nothing matched", the one answer a caller cannot tell apart from the
truth. Status is always checked; 403 and 429 are never retried.

**The rate is found, not configured.** It rises by 1 rpm per clean stretch and is
cut on every block, the cooldown doubles per consecutive refusal, and the run
halts after three with everything saved. A published `Crawl-delay` lowers the
ceiling and never raises it. Being blocked is remembered *between* invocations, so
the next command refuses to start early instead of arguing with the edge — that is
what turns a rate limit into a real ban. Deliberately probing for the threshold
would mean hammering someone else's servers for a number that is neither published
nor stable.

For when finishing today matters less than never being blocked:

```bash
garimpo hunt --profile perfil.json --gentle
```

Roughly 2 rpm, one page at a time, a five-minute sit-down every 60 requests, ten
minutes of silence at the first refusal. A statewide sweep takes hours. That is the
trade.

`--window 02:00-07:00` confines a run to chosen hours (it may wrap midnight): a
site under load polices traffic harder than a quiet one. And `garimpo plan` prints
what the sweep will cost in requests and minutes before any of it is spent, so a
nationwide run can be turned down before it starts rather than abandoned an hour
in.

There is no proxy rotation, fingerprint randomisation or challenge solving here,
and there will not be. Those are evasion rather than good manners, and evasion is
what escalates a temporary limit into a permanent one.

### One request buys 50 cards or 1 ad page

That 50× asymmetry is the whole economy of the tool. Cheap filters (price, title,
photos, recency) run on search cards before any ad page is fetched; description,
attributes and seller history only exist on the ad page, so defect and seller
filters necessarily pay for it. Stages declare which they need, and the pipeline
puts them in that order rather than trusting the author to. Ad pages already read
inside `--refresh-after-days` are not read again, so a repeat hunt over a known
product costs almost nothing.

### Listing pages ship no stable selectors

Class names are build-hashed styled-components. Details come from the page's
schema.org `Product` block and its analytics payload; the seller card and location,
which exist only in the markup, are found by anchoring on visible Portuguese labels
("Vendas concluídas") and parsed from page text by pure functions that are tested
against captured pages rather than a live site.

## Triage

Stages are data, validated by zod, so a pipeline can be saved and replayed:

| stage | reads | judges |
| --- | --- | --- |
| `price-range` | card | price band, and whether an unpriced ad counts |
| `title-match` | card | required and excluded patterns |
| `for-sale` | card | drops wanted-ads, rentals, accessory listings |
| `recency` | card | age from the card's own relative date |
| `has-image` | card | photo count |
| `condition` | detail | OLX's own "Condição" values |
| `defects` | detail | the description, by severity |
| `seller` | detail | rating, sales, cancellations, account age, verification |
| `attribute` | detail | any attribute, by allow/deny list or regex |

### Defect detection reads negation

The hard part is not finding defect words, it is not being fooled by honest
sellers. "Sem trincos, sem linha verde, nenhum risco" describes a pristine phone,
and a keyword filter throws exactly those ads away while keeping the ones that
never mention condition at all. Every hit is checked for a negator in the words
before it, bounded by the clause — so a "sem carregador" cannot cancel a cracked
screen mentioned in the previous sentence.

The lexicon is data (`garimpo template` prints it) because it is the part most
worth tuning: "linha verde" decides a phone screen and means nothing on a bicycle.

## Gem hunting

The premise: an ad is interesting when it is far below what the same product in
comparable shape sells for.

- The reference is the median of the **clean** ads — the ones that passed triage.
  Including the wrecks lowers the median, which raises the bar every genuine
  bargain has to clear.
- Median and MAD, not mean and standard deviation. Used-goods prices are skewed and
  salted with R$ 1 placeholder listings; both tails drag a mean around, and a
  standard deviation computed over them is wide enough to call nothing unusual.
- A bargain lives in a **band**. Far enough below the median stops meaning "cheap"
  and starts meaning "not the thing advertised" — a scam, a typo, a deposit on an
  instalment plan, a case sold under the phone's name. Anything under
  `implausibleBelowPct` of the median comes back as `suspect`: surfaced, because
  occasionally it is real, never ranked first.
- Quality and seller trust multiply into the score rather than adding to it, so no
  discount is large enough to redeem a broken unit from someone who cancels every
  order.
- Below `minReferenceSize` comparables it refuses to judge at all. Without knowing
  what the product costs there is no such thing as a discount.

Verdicts: `gem`, `watch`, `suspect`, `rejected`.

## Runs are resumable, and say what they missed

Everything lands in SQLite under `--data-dir` (default `.garimpo`). Ads are keyed
globally, so a product swept last week is already known this week and only its price
needs refreshing. Shards record how far they got, so a block on page 40 of 100
resumes at 41. Re-running a command with `--run <id>` continues; it does not
restart.

Two coverage limits are reported rather than hidden:

- A slice OLX says holds more than 5.000 ads that could not be split further is
  marked `truncated`, and `plan` says so in its notes.
- **Ads OLX lists without a price appear in no price band**, so where a slice had to
  be split by price they are unreachable. `plan` warns when that applies.

## Reading results

`report` is the interface, not the database. It gives the funnel (how many ads each
stage dropped, and the grouped reasons), the price range, and the top finds with the
reason for each. `--json` for the same thing structured.

The funnel is the number that matters: "5 of 57 passed, 43 dropped for a title
without 's22'" tells you whether a filter is working or eating the corpus.

## Development

```bash
npm run ci     # lint, typecheck, tests, build
```

Parsing, sharding, pacing, triage and gem scoring are pure and tested without a
browser, against page text captured from real ads. Only the scrapers need Chromium.

## License

MIT — see LICENSE.
