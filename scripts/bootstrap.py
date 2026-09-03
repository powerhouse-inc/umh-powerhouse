#!/usr/bin/env python3
"""One-shot bootstrap: wires Paperless to the Production Ledger reactor.

Runs as a docker-compose service. All services are containers on the compose
network, addressed by service name. Idempotent — every step checks before it
writes, so re-running on every `docker compose up` is the intended mode.

What it ensures, in order:
  1. a Paperless document type "Purchase Order" that auto-assigns to documents
     containing the word "order" (matching_algorithm=1, Any word)
  2. a "PL Dashboard" drive (slug pl-dashboard, preferredEditor
     production-ledger-dashboard) on the reactor
  3. a "Paperless Connection" sync document (umh/paperless-sync) inside it
  4. an enabled mapping Purchase Order -> umh/production-ledger, carrying the
     UMH extraction instructions (valid lines/parts + the human-gate guard)
  5. the "Powerhouse push sync" workflow in Paperless; re-requests
     registration if Paperless was wiped

Secrets (connection credentials, AI config, webhook secret) are bootstrapped
by the forked paperless-sync processor from switchboard's environment — this
script never sees them.

Adapted from powerhouse-inc/paperless-billing scripts/bootstrap.py.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

PAPERLESS_URL = os.environ.get("BOOTSTRAP_PAPERLESS_URL", "http://webserver:8000").rstrip("/")
REACTOR_URL = os.environ.get("BOOTSTRAP_REACTOR_URL", "http://switchboard:3000").rstrip("/")
ADMIN_USER = os.environ.get("PAPERLESS_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("PAPERLESS_ADMIN_PASSWORD", "paperless")
REACTOR_WAIT_SECONDS = int(os.environ.get("BOOTSTRAP_REACTOR_WAIT_SECONDS", "300"))
PAPERLESS_URL_FROM_REACTOR = os.environ.get("BOOTSTRAP_PAPERLESS_URL_FROM_REACTOR", "http://webserver:8000").rstrip("/")
SUBGRAPH_URL = os.environ.get("BOOTSTRAP_SUBGRAPH_URL", "http://switchboard:3000/graphql/paperless-webhook")

DRIVE_NAME = "PL Dashboard"
DRIVE_SLUG = "pl-dashboard"
# A drive's preferredEditor must target powerhouse/document-drive — that is
# the dashboard APP. Individual ledgers open in production-ledger-editor
# automatically because its documentTypes match.
DRIVE_PREFERRED_EDITOR = "production-ledger-dashboard"
SYNC_DOC_NAME = "Paperless Connection"
DOCTYPE_NAME = "Purchase Order"
TARGET_DOCUMENT_TYPE = "umh/production-ledger"
WORKFLOW_NAME = "Powerhouse push sync"

# What the LLM is told when extracting a purchase-order PDF into a ledger.
# The extraction engine already shows it the document model's operations; the
# instructions pin the UMH vocabulary and, critically, the human gate: the
# extractor must never approve, open, or sign — a reviewer does that.
MAPPING_INSTRUCTIONS = """\
This document is a customer purchase order for a manufacturing run. Fill the
commitment ONLY, using exclusively the SET_COMMITMENT operation. Never use
APPROVE_ORDER, OPEN_LEDGER, START_RUN, RECORD_ACTUALS_SNAPSHOT, CLOSE_OUT,
CLOSE_EARLY, ACKNOWLEDGE or VOID_LEDGER: a human reviews and authorises the order.

Field guidance:
- customer: the buyer on the order. manufacturer: the supplier receiving it.
- line: the production line INSTANCE that will run the job. Valid values:
  automotive-welding-1, electronics-through-hole-1, metal-parts-fabrication-1,
  window-frame-1. Choose by product family.
- partNumber: the internal part/recipe code. Valid values per line:
  automotive-welding-1: FRAME-WELD-A, FRAME-WELD-B;
  electronics-through-hole-1: THT-MAIN-A, THT-SENS-B;
  metal-parts-fabrication-1: BRACKET-SS-A, PANEL-AL-B;
  window-frame-1: WIN-STD-A, WIN-LRG-B.
  Map the ordered item to the closest code; put the order's own item wording
  in partDescription.
- committedQuantity: the ordered quantity (integer).
- committedQualityPct / committedOeeFloorPct: quality / OEE floors if the
  order or its terms state them; otherwise omit.
- deadline: the requested delivery date, as an ISO timestamp.
- currency: ISO 4217 code (EUR unless stated otherwise).
- Do NOT set orderId — it is assigned by the factory at approval.
"""


def log(msg: str) -> None:
    print(f"[bootstrap] {msg}", flush=True)


def http(method: str, url: str, body=None, headers=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def gql(query: str, variables=None):
    out = http("POST", f"{REACTOR_URL}/graphql", {"query": query, "variables": variables or {}})
    if out.get("errors"):
        raise RuntimeError(f"GraphQL: {out['errors'][0].get('message')}")
    return out["data"]


def wait_for(name: str, probe, seconds: int) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            probe()
            log(f"{name} is up")
            return
        except urllib.error.HTTPError:
            # The server answered with an error status — it is up.
            log(f"{name} is up")
            return
        except Exception as error:  # noqa: BLE001
            if time.monotonic() >= deadline:
                raise SystemExit(f"[bootstrap] gave up waiting for {name}: {error}")
            time.sleep(3)


# ---------------------------------------------------------------- Paperless

def paperless_token() -> str:
    out = http("POST", f"{PAPERLESS_URL}/api/token/", {"username": ADMIN_USER, "password": ADMIN_PASSWORD})
    return out["token"]


def ensure_document_type(token: str) -> int:
    headers = {"Authorization": f"Token {token}"}
    listing = http("GET", f"{PAPERLESS_URL}/api/document_types/?page_size=100", headers=headers)
    for entry in listing.get("results", []):
        if entry["name"].lower() == DOCTYPE_NAME.lower():
            log(f'document type "{DOCTYPE_NAME}" exists (id={entry["id"]})')
            return entry["id"]
    created = http("POST", f"{PAPERLESS_URL}/api/document_types/", {
        "name": DOCTYPE_NAME,
        "match": "order",
        "matching_algorithm": 1,  # Any word
        "is_insensitive": True,
    }, headers=headers)
    log(f'created document type "{DOCTYPE_NAME}" (id={created["id"]}, matches any word "order")')
    return created["id"]


def workflow_exists(token: str) -> bool:
    headers = {"Authorization": f"Token {token}"}
    listing = http("GET", f"{PAPERLESS_URL}/api/workflows/", headers=headers)
    return any(w.get("name") == WORKFLOW_NAME for w in listing.get("results", []))


# ------------------------------------------------------------------ Reactor

def ensure_drive() -> str:
    data = gql("""
      { findDocuments(search:{type:"powerhouse/document-drive"}) { items { id name slug } } }""")
    for item in data["findDocuments"]["items"]:
        if item.get("slug") == DRIVE_SLUG:
            log(f'drive "{DRIVE_NAME}" exists (id={item["id"]})')
            return item["id"]
    data = gql("""
      mutation($name:String!,$slug:String,$editor:String) {
        DocumentDrive { createDocument(name:$name, slug:$slug, preferredEditor:$editor) { id } } }""",
        {"name": DRIVE_NAME, "slug": DRIVE_SLUG, "editor": DRIVE_PREFERRED_EDITOR})
    drive_id = data["DocumentDrive"]["createDocument"]["id"]
    log(f'created drive "{DRIVE_NAME}" (id={drive_id}, preferredEditor={DRIVE_PREFERRED_EDITOR})')
    return drive_id


def ensure_sync_document(drive_id: str) -> str:
    data = gql("""
      query($id:String!) {
        documentOutgoingRelationships(
          sourceIdentifier:$id, relationshipType:"child", paging:{limit:100}) {
            items { id name documentType } } }""", {"id": drive_id})
    for item in data["documentOutgoingRelationships"]["items"]:
        if item["documentType"] == "umh/paperless-sync":
            log(f'sync document exists (id={item["id"]})')
            return item["id"]
    data = gql("""
      mutation($name:String!,$parent:String) {
        PaperlessSync { createDocument(name:$name, parentIdentifier:$parent) { id } } }""",
        {"name": SYNC_DOC_NAME, "parent": drive_id})
    doc_id = data["PaperlessSync"]["createDocument"]["id"]
    log(f'created sync document "{SYNC_DOC_NAME}" (id={doc_id}) in drive {drive_id}')
    return doc_id


def read_sync_state(doc_id: str):
    data = gql("""
      query($id:String!) {
        PaperlessSync { document(identifier:$id) { document { state { global {
          mappings { id paperlessTypeId targetDocumentType enabled }
          push { enabled subgraphUrl paperlessWorkflowId error }
          credentials { instanceUrl }
          connection { status }
        } } } } } }""", {"id": doc_id})
    return data["PaperlessSync"]["document"]["document"]["state"]["global"]


def ensure_connection(doc_id: str, token: str) -> None:
    """Local-dev convenience: the admin token is minted from the dev instance,
    so .env never needs PAPERLESS_API_TOKEN."""
    state = read_sync_state(doc_id)
    status = (state.get("connection") or {}).get("status")
    if state.get("credentials") and status != "FAILED":
        log(f"connection already set ({state['credentials']['instanceUrl']}, status={status})")
        return
    if status == "FAILED":
        log("recorded connection FAILED (stale token after a wipe?) — re-setting it")
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    gql("""
      mutation($doc:PHID!,$input:PaperlessSync_SetConnectionInput!) {
        PaperlessSync { setConnection(docId:$doc, input:$input) { id } } }""",
        {"doc": doc_id, "input": {"instanceUrl": PAPERLESS_URL_FROM_REACTOR, "apiToken": token}})
    gql("""
      mutation($doc:PHID!,$input:PaperlessSync_RequestConnectionTestInput!) {
        PaperlessSync { requestConnectionTest(docId:$doc, input:$input) { id } } }""",
        {"doc": doc_id, "input": {"requestedAt": now}})
    log(f"set connection to {PAPERLESS_URL_FROM_REACTOR} and requested a connection test")


def ensure_mapping(doc_id: str, paperless_type_id: int) -> None:
    state = read_sync_state(doc_id)
    existing = next((m for m in state["mappings"] if m["targetDocumentType"] == TARGET_DOCUMENT_TYPE), None)
    if existing is None:
        gql("""
          mutation($doc:PHID!,$input:PaperlessSync_AddMappingInput!) {
            PaperlessSync { addMapping(docId:$doc, input:$input) { id } } }""",
            {"doc": doc_id, "input": {
                "id": str(uuid.uuid4()),
                "paperlessTypeId": paperless_type_id,
                "paperlessTypeName": DOCTYPE_NAME,
                "targetDocumentType": TARGET_DOCUMENT_TYPE,
                "enabled": True,
                "instructions": MAPPING_INSTRUCTIONS,
            }})
        log(f"added mapping {DOCTYPE_NAME}(id={paperless_type_id}) -> {TARGET_DOCUMENT_TYPE}")
    elif existing["paperlessTypeId"] != paperless_type_id or not existing["enabled"]:
        gql("""
          mutation($doc:PHID!,$input:PaperlessSync_UpdateMappingInput!) {
            PaperlessSync { updateMapping(docId:$doc, input:$input) { id } } }""",
            {"doc": doc_id, "input": {
                "id": existing["id"],
                "paperlessTypeId": paperless_type_id,
                "paperlessTypeName": DOCTYPE_NAME,
                "enabled": True,
            }})
        log(f"updated mapping to {DOCTYPE_NAME}(id={paperless_type_id}) (was id={existing['paperlessTypeId']})")
    else:
        log("mapping is current")


def heal_push_registration(doc_id: str, token: str) -> None:
    """After `docker compose down -v` Paperless loses the workflow but the sync
    document still records a successful registration; detect and re-request."""
    state = read_sync_state(doc_id)
    push = state.get("push")
    if not push or not push.get("subgraphUrl"):
        gql("""
          mutation($doc:PHID!,$input:PaperlessSync_RequestPushRegistrationInput!) {
            PaperlessSync { requestPushRegistration(docId:$doc, input:$input) { id } } }""",
            {"doc": doc_id, "input": {
                "subgraphUrl": SUBGRAPH_URL,
                "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            }})
        log(f"requested push registration for {SUBGRAPH_URL}")
        for _ in range(10):
            if workflow_exists(token):
                log(f'workflow "{WORKFLOW_NAME}" registered')
                return
            time.sleep(3)
        log(f'WARNING: workflow "{WORKFLOW_NAME}" still absent — check `docker compose logs switchboard` for [paperless-sync] errors')
        return
    for _ in range(10):
        if workflow_exists(token):
            log(f'workflow "{WORKFLOW_NAME}" present in Paperless')
            return
        time.sleep(3)
    gql("""
      mutation($doc:PHID!,$input:PaperlessSync_RequestPushRegistrationInput!) {
        PaperlessSync { requestPushRegistration(docId:$doc, input:$input) { id } } }""",
        {"doc": doc_id, "input": {
            "subgraphUrl": push["subgraphUrl"],
            "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }})
    log("workflow was missing in Paperless; re-requested push registration")
    for _ in range(10):
        if workflow_exists(token):
            log(f'workflow "{WORKFLOW_NAME}" registered')
            return
        time.sleep(3)
    log(f'WARNING: workflow "{WORKFLOW_NAME}" still absent — check `docker compose logs switchboard` for [paperless-sync] errors')


def main() -> None:
    wait_for("Paperless", lambda: http("GET", f"{PAPERLESS_URL}/api/", timeout=5), 120)
    token = paperless_token()
    doctype_id = ensure_document_type(token)

    # Wait for the LEDGER PACKAGE's subgraph, not just /health — this is what
    # proves the registry install + supergraph composition succeeded.
    wait_for("reactor", lambda: gql("{ PaperlessSync { documents { totalCount } } }"),
             REACTOR_WAIT_SECONDS)
    drive_id = ensure_drive()
    doc_id = ensure_sync_document(drive_id)
    ensure_connection(doc_id, token)
    ensure_mapping(doc_id, doctype_id)
    time.sleep(5)  # processor's env bootstrap is async
    heal_push_registration(doc_id, token)
    log("done")


if __name__ == "__main__":
    sys.exit(main())
