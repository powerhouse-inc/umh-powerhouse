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
                                    settle (rates from UMH cost tables) → sign
```



## Run it

```bash
cp .env.example .env    # fill in PAPERLESS_AI_API_KEY and UMH_LEDGER_VERSION
./start.sh
```

First run pulls ~3 GB. When it finishes it opens Paperless and the PL
Dashboard drive in Connect.


| Service                            | Endpoint                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Paperless                          | [http://localhost:8000](http://localhost:8000) — `admin` / `paperless`                    |
| Connect (PL Dashboard)             | [http://localhost:3000](http://localhost:3000)                                            |
| Reactor API                        | [http://localhost:4001/graphql](http://localhost:4001/graphql)                            |
| Machine simulator                  | [http://localhost:8081](http://localhost:8081) (Create Order form fix injected via nginx) |
| Gateway (stop-reason + costs APIs) | [http://localhost:80](http://localhost:80)                                                |




## The demo walk

1. Drop one of the sample POs (bundled in [`demo-pdfs/`](demo-pdfs/)) into `.local/consume/`, or upload it at the Paperless UI. It must
   contain the word "order".
2. After OCR, the forked paperless-sync engine extracts the commitment into a
  **DRAFT Production Ledger** in the PL Dashboard drive, with the original
   scan attached — open the ledger and click **View Order PDF** to verify the
   extraction side-by-side.
3. **Approve** — this creates the real order on the simulated floor and binds
  its UUID. **Open Ledger** freezes the baseline.
4. The `umh-order-poller` streams machine actuals into the evidence trail
  every 15 s (progress strip, scrap ticks, quality).
5. When the floor closes the run: **Compute Settlement** (scrap/downtime
  rates prefilled from UMH's cost tables via the costs-api dataflow), then
   sign both parties.



## Layout

- `docker-compose.yml` — everything: Paperless (redis + webserver), Powerhouse
(switchboard + connect images, packages installed from the registry at
startup), one-shot `bootstrap`, and the vendored UMH factory core
(simulator, umh-core, TimescaleDB, pgbouncer, nginx).
- `scripts/bootstrap.py` — idempotent wiring: Paperless "Purchase Order" type,
the `pl-dashboard` drive, the sync document, the mapping with UMH extraction
instructions (including the human-gate guard), webhook registration healing.
- `umh-factory/` — vendored from a v1.4.0 `--fixed-demo` deployment of
[umh-factory-demo](https://github.com/united-manufacturing-hub/umh-factory-demo):
umh-core config (with the costs-api dataflow), simulator config, nginx
gateway (CORS + costs route + simulator form fix), and the TimescaleDB init
SQL (schema, views, hypertables, cost seeds) that replaces the upstream
builder. Grafana is deliberately omitted — the ledger demo does not use it.



## Notes

- **Ports collide with a standalone** `~/umh-factory` **deployment** (80, 8081,
502, 4840-4852, 8090, 5432). `start.sh` refuses to start while one runs.
- `docker compose down -v` wipes Paperless + reactor state; the factory dirs
(`timescaledb-data/`, `simulator-data/`, `umh-core-data/`) live on disk —
delete them for a truly fresh factory.
- The simulator's own state (`/app/simulator.db`) lives in the container's
writable layer: prefer `docker compose stop` over recreating it.
- `PH_IMAGE_TAG`, `UMH_LEDGER_VERSION` and the registry form one
compatibility set — move them together.

