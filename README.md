# UMH Powerhouse Demo

Purchase-order PDFs → Powerhouse Production Ledgers → a simulated UMH factory
floor — entirely in Docker.

```
PDF into Paperless ─OCR→ paperless-sync (LLM) ─→ DRAFT ledger + attached scan
                                                    │  human reviews & approves
                                                    ▼
                                    POST /api/orders on the factory floor
                                                    │
     evidence trail ←─ umh-order-poller ←─ machine actuals (OPC-UA → UMH)
                                                    │
                                    auto close-out (rates from UMH cost tables) → acknowledge
```



## Setup

- **Install a Docker runtime** — the demo needs `docker` plus Compose v2.

  | Platform | Install                                                                          |
  | -------- | -------------------------------------------------------------------------------- |
  | macOS    | [OrbStack](https://orbstack.dev) — `brew install --cask orbstack`                |
  | Linux    | [Docker Engine](https://docs.docker.com/engine/install/) + the Compose v2 plugin |
  | Windows  | [Docker Desktop](https://www.docker.com/products/docker-desktop/), WSL2 backend  |

  `switchboard` and `connect` ship `linux/arm64` images, so they run natively on
  Apple Silicon — no Rosetta or QEMU emulation, and no `platform:` pin needed.

  **On macOS, OrbStack is still the easier option.** It installs no privileged
  helper, so it cannot hit the macOS "Malware Blocked / com.docker.vmnetd" false
  positive that leaves Docker Desktop unable to start.

- Clone this repository

```bash
git clone https://github.com/powerhouse-inc/umh-powerhouse.git
cd umh-powerhouse
```

## Run it

```bash
cp .env.example .env    # fill in PAPERLESS_AI_API_KEY and UMH_LEDGER_VERSION
./start.sh
```

First run pulls ~3 GB. When it finishes it opens Paperless and the PL
Dashboard drive in Connect.

To also accept purchase orders by email, see
[Purchase orders by email](#purchase-orders-by-email-optional). It is off by
default and the demo does not need it.


| Service                            | Endpoint                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Paperless                          | [http://localhost:8000](http://localhost:8000) — `admin` / `paperless`                    |
| Connect (PL Dashboard)             | [http://localhost:3000](http://localhost:3000)                                            |
| Reactor API                        | [http://localhost:4001/graphql](http://localhost:4001/graphql)                            |
| Machine simulator                  | [http://localhost:8081](http://localhost:8081) (Create Order form fix injected via nginx) |
| Gateway (stop-reason + costs APIs) | [http://localhost:80](http://localhost:80)                                                |




## The demo walk

1. Drop one of the sample POs (bundled in [`demo-pdfs/`](demo-pdfs/)) into `.local/consume/`, or upload it at the Paperless UI. It must
   contain the word "order". With [email intake](#purchase-orders-by-email-optional)
   on, you can also email it as a PDF attachment and give the mail the Gmail
   label `paperless`.
2. After OCR, the forked paperless-sync engine extracts the commitment into a
  **DRAFT Production Ledger** in the PL Dashboard drive, with the original
   scan attached — open the ledger and click **View Order PDF** to verify the
   extraction side-by-side.
3. **Approve** — this creates the real order on the simulated floor and binds
  its UUID. **Open Ledger** freezes the baseline.
4. The `umh-order-poller` streams machine actuals into the evidence trail
  every 15 s (progress strip, scrap ticks, quality).
5. When the floor reports the run complete, the poller **closes the ledger
   out automatically**: a conformance verdict per dimension, the internal run
   cost (rates from UMH's cost tables via the costs-api dataflow), the
   projected contractual exposure, and a ship/hold recommendation. Controlling
   then **acknowledges** the record.



## Purchase orders by email (optional)

Off by default. When it is on, Paperless checks a Gmail label every minute for
new mail and imports its PDF attachments. An emailed PDF becomes the same
Paperless document as a dropped one, so it goes through the same steps from
there. Dropping and uploading PDFs keep working whether email is on or off.

It works with personal Gmail and with Google Workspace (company) accounts.

### 1. Create a Google app password

Paperless signs in to Gmail over IMAP, and Google does not accept the
account's normal password for that. It needs an app password: a 16-letter
password that only this app uses and that you can revoke on its own.

1. Sign in to the Google account that receives the purchase orders and open
   [myaccount.google.com/security](https://myaccount.google.com/security).
   Under **How you sign in to Google**, turn on **2-Step Verification**. App
   passwords need it.
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   (or type "App passwords" into the search bar at the top of your Google
   Account page).
3. Enter a name such as `Paperless demo` and click **Create**.
4. Copy the 16-letter password Google shows. You only see it once; if you lose
   it, delete it and create a new one.

If the page says *"The setting you are looking for is not available for your
account"*, app passwords are blocked for this account. Either 2-Step
Verification is off, or the account uses Advanced Protection (security keys
only), or on a Workspace account the admin has disabled app passwords or IMAP.
On a company account, ask your Google Workspace admin to allow both.

To revoke Paperless's access, delete the app password on the same page.
Changing the account's Google password revokes all its app passwords as well.

### 2. Create the Gmail label

In Gmail, create a label named `paperless` (left sidebar → **Labels** → **+**).
Paperless only reads mail with this label, so nothing else in the mailbox is
imported. Apply it to a purchase-order mail by hand, or create a Gmail filter
that applies it automatically, for example to mail from a supplier with a PDF
attached.

### 3. Put the settings in `.env`

```bash
PAPERLESS_MAIL_ENABLED=true
PAPERLESS_MAIL_ADDRESS=you@company.com
PAPERLESS_MAIL_APP_PASSWORD=abcdefghijklmnop   # the app password, without spaces
```

`.env` is in `.gitignore`. Never put the password in `.env.example` or
`docker-compose.yml`. The optional settings (another label name, sender or
subject filters, how far back to look, how often to check, a non-Gmail IMAP
server) are listed in [`.env.example`](.env.example).

### 4. Apply it

Run `./start.sh`. On a stack that is already running, this is enough:

```bash
docker compose run --rm mail-setup
```

It checks the login first and stops with a clear message if Google rejects it.
On success it prints `email intake: on …`. To test it, email yourself a PDF from
[`demo-pdfs/`](demo-pdfs/) and give the mail the `paperless` label. Within a
minute the PDF appears in Paperless, and the DRAFT ledger follows once it has
been read and extracted.

### How it behaves

- **Only PDF attachments are imported.** The mail text is not: this stack runs
  Paperless without Tika and Gotenberg, which it would need to turn an email
  body into a document.
- **Each mail is imported once.** Afterwards Gmail shows a second label on it,
  `paperless-imported`, and Paperless skips mail that has it. Only mail from
  the last 7 days is read, so turning it on does not import your whole history.
- **Every PDF in the label becomes a Purchase Order**, even one that never
  contains the word "order" (a German *Bestellung*, say). The label is the
  signal, so only label purchase orders.
- **To turn it off**, set `PAPERLESS_MAIL_ENABLED=false` and run `./start.sh`
  again. The rule is disabled and Paperless stops logging in to the mailbox.
  The app password stays stored in Paperless until `docker compose down -v`.
  Delete it at Google if Paperless should lose access completely.
- **Already added the mailbox by hand** in Paperless (under **Mail**)? The
  script takes over the account with the same address instead of adding a
  second one. A rule you created by hand stays enabled; disable it if it reads
  the same mail, or each PDF is imported twice. The script warns when it finds
  one.

### Troubleshooting

Paperless logs every mail check. Open **Logs → mail** in the Paperless UI, or:

```bash
docker compose exec webserver tail -n 30 /usr/src/paperless/data/log/mail.log
```

| Log says | Fix |
| --- | --- |
| `Folder paperless does not exist` | Create the Gmail label, spelled as in `PAPERLESS_MAIL_FOLDER` |
| `Processed 0 matching mail(s)` | The mail lacks the label, is older than 7 days, has no PDF, or was already imported |
| `refused the login` (from `mail-setup`) | Use an app password, not the normal one; on Workspace, ask the admin to allow app passwords and IMAP |

## Layout

- `docker-compose.yml` — everything: Paperless (redis + webserver), Powerhouse
(switchboard + connect images, packages installed from the registry at
startup), the one-shots `seed` and `mail-setup`, and the vendored UMH factory
core (simulator, umh-core, TimescaleDB, pgbouncer, nginx).
- `scripts/seed.mjs`, `scripts/graph.mjs` — idempotent wiring, copied from the
ledger package's demo (`demo/scripts/` in umh-production-ledger): the Paperless
"Purchase Order" type, the drives, the connections and the workflows that do
the integration.
- `scripts/paperless-mail.mjs` — optional email intake: applies the
`PAPERLESS_MAIL_*` settings in `.env` to Paperless's mail account and rule, or
disables the rule. Maintained here, not upstream.
- `umh-factory/` — vendored from a v1.4.0 `--fixed-demo` deployment of
[umh-factory-demo](https://github.com/united-manufacturing-hub/umh-factory-demo):
umh-core config (with the costs-api dataflow), simulator config, nginx
gateway (CORS + costs route + simulator form fix), and the TimescaleDB init
SQL (schema, views, hypertables, cost seeds) that replaces the upstream
builder. Grafana is deliberately omitted — the ledger demo does not use it.



## Notes

- **The floor is tuned for demo pace.** Every `cycle_time_ms` and
  `auto_restore_time_ms` in `umh-factory/simulator-config/lines/` is 1/40 of
  upstream's, and `tick_rate_ms` is 25 rather than 100 (a 100 ms tick cannot
  represent a 250 ms cycle, and an inaccurate actual would break the
  ideal-vs-actual match OEE depends on). An 80-unit order finishes in ~80 s
  instead of ~55 min. This is done in the config rather than with
  `SIMULATOR_TIME_SCALE` deliberately: time-scaling leaves the *nominal* cycle
  time unchanged, so the historian's "ideal" no longer matches what machines
  actually do and `performance_pct` pegs at 100. Cutting the configured times
  keeps every reported figure honest.

- **The factory never invents orders.** The simulator's fake ERP is run in
  manual mode (`SIMULATOR_ERP_MODE=manual`), so every order on the floor
  originates from an approved Production Ledger. Upstream's default mints a
  random order every 30 s, which would compete with the Paperless flow.
- **Ports collide with a standalone** `~/umh-factory` **deployment** (80, 8081,
502, 4840-4852, 8090, 5432). `start.sh` refuses to start while one runs.
- `docker compose down -v` wipes Paperless + reactor state; the factory dirs
(`timescaledb-data/`, `simulator-data/`, `umh-core-data/`) live on disk —
delete them for a truly fresh factory.
- The simulator's own state (`/app/simulator.db`) lives in the container's
writable layer: prefer `docker compose stop` over recreating it.
- `PH_IMAGE_TAG`, `UMH_LEDGER_VERSION` and the registry form one
compatibility set — move them together.

