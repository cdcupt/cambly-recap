# Cambly Recap

An unattended weekly study-recap generator for [Cambly](https://www.cambly.com)
learners. Once a week it fetches your past week of lessons, summarizes them with an
LLM, publishes a private study page, and emails you the link — so the language you
worked on actually sticks.

Each week's page distills your lessons into:

- **Vocabulary** — new words and expressions, with a real example from your own speech
- **Grammar** — the patterns you were corrected on, grouped by rule
- **Phrasing** — more natural ways to say what you said
- **Coaching** — your tutor's notes and the AI coach's summary, plus a "next focus"
- **Practice** — tap-to-reveal drills generated from your own mistakes

It runs itself: a cron-fired job does the work every Monday morning and gets out of
the way. Every run ends in exactly one of four outcomes, and **every** outcome sends
one email — silence is treated as a bug.

## What it stores

Only JSON and HTML. It fetches lesson transcripts, corrections, and feedback (never
video), normalizes them to compact JSON, and renders a static site. No lesson data,
session cookies, or API keys are ever committed to the repo.

## Architecture

```
cron ─▶ generator container ──▶ fetch ▶ normalize ▶ summarize ▶ build ▶ render ▶ mail
             (Node 22)              │        │           │          │        │       │
                                 Cambly   (local)     OpenAI    (gates)  static   Resend
                                                                          site
                                                                            │
                             always-on caddy container ◀── serves ──────────┘
                             (basic auth + /healthz.json)
```

- **Zero dependencies.** Node 22's native `fetch` covers all three APIs (Cambly,
  OpenAI, Resend). There is no `npm install` and no lockfile to drift.
- **Two containers.** A short-lived **generator** (`docker compose run --rm generator`)
  writes the static site and exits; an always-on **caddy** container serves that site
  read-only on `127.0.0.1:8107` behind HTTP basic auth, with an auth-exempt
  `/healthz.json` for uptime monitoring.
- **Bring your own edge.** Put the site behind any reverse proxy / TLS terminator you
  already run; it only needs to `reverse_proxy` the caddy container. A sample edge
  snippet pattern is described in the ops files.
- **LLM + email.** Summarization uses the OpenAI API; notifications use Resend.

## The four run outcomes

| Outcome        | Exit | What happens |
|----------------|:----:|--------------|
| `published`    | 0    | The target week had ≥1 lesson → the site is rebuilt and a 📗 recap email is sent. |
| `no-classes`   | 0    | The target week had 0 lessons → an empty-week stub is recorded and a 📭 "no classes" email is sent (never silent). |
| `auth-expired` | 3    | Your Cambly session expired → nothing is published, an amber banner is re-rendered on the archive, and a 🔑 email tells you how to refresh. |
| `fetch-failed` | 2    | Fetch/summarize/build/render failed after retries → the site is left unchanged and a ⚠️ email reports the stage and error. |

Missed weeks self-heal: whenever a run succeeds, any complete-but-unbuilt week back to
`FIRST_WEEK` is filled in automatically. Re-runs are idempotent — an already-built week
makes zero LLM calls and sends zero emails.

## Setup

### 1. Configure

Copy the env template and fill in real values on your server:

```bash
cp ops/deploy.env.example deploy.env   # then edit, and chmod 600
```

| Var | Purpose |
|-----|---------|
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Summarizer (any chat-completions model). |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO` | One email per run. `MAIL_FROM` must be a verified Resend sender. |
| `SITE_URL` | Public base URL for the email deep links and the healthz check (no trailing slash). |
| `CAMBLY_UID` | Your Cambly user id. |
| `FIRST_WEEK` | Monday (`YYYY-MM-DD`) of your earliest week — the backfill floor. |
| `BASIC_AUTH_HASH` | bcrypt for the site's basic auth: `docker run --rm caddy:2-alpine caddy hash-password`. |

Optional `CAMBLY_BASE_URL` / `OPENAI_BASE_URL` / `RESEND_BASE_URL` seams exist for
testing against mocks.

### 2. Provide a Cambly session

The fetcher authenticates with cookies from a logged-in Cambly session, stored in a
`cambly-state.json` file — a browser **storage state** export: an array of `cookies`
plus a top-level `_ua` field holding the browser's user-agent string.

The harvest is intentionally out of scope for this repo (do it however you like — for
example, log in to Cambly in a real browser and export its cookies via a Playwright
`storageState`, adding the `_ua` field). Save the result as `cambly-state.json` and
mount it read-only into the generator (see `ops/docker-compose.yml`). When the session
later expires, the tool emails you the two-step refresh: re-harvest the cookies, copy
the refreshed `cambly-state.json` to the server, and re-run the generator.

### 3. Deploy

Build and run the generator once to verify, then bring up the serving container:

```bash
docker compose -f ops/docker-compose.yml run --rm generator   # one generate pass
docker compose -f ops/docker-compose.yml up -d cambly-caddy    # serve the site
```

Then install the weekly cron line and (optionally) a monitor:

```bash
cat ops/cambly-recap.cron   # Sun 23:30 UTC = Mon 07:30 Asia/Shanghai, flock-guarded
```

`ops/gatus-cambly.yaml` is a ready-to-paste [Gatus](https://github.com/TwiN/gatus)
endpoint that polls the auth-exempt `/healthz.json` and goes red on any failed run.

## Develop & test

```bash
make test            # node --test (zero dependencies, no network)
make test-coverage   # with line coverage
```

Tests are hermetic: the summarizer, mailer, and Cambly APIs are exercised through the
`*_BASE_URL` env seams against local `node:http` mocks, with the clock injected. The
repo ships only **synthetic** fixtures; tests that exercise a private lesson archive
skip gracefully when that archive is absent (i.e. on any clone).

## How it was built

Designed and implemented with an SDD (spec-driven) multi-agent workflow: a PRD and
design/tech docs drove the build, and a beta quality pass verified every feature
before release.

## License

MIT — see [LICENSE](LICENSE).
