// Wires the demo on a running reactor: two drives, the connections to the
// factory floor and the archive, and the two workflows that replace this
// package's `umh-order-poller` and `paperless-sync` processors.
//
//   bun run demo:seed     # node demo/scripts/seed.mjs
//
// Idempotent by name: every step looks before it writes, so re-running it after
// a restart is the intended mode. It never edits a workflow that already
// exists — delete the document and re-run to rebuild one.
//
// Environment (defaults suit demo/docker-compose.yml + `ph vetra`):
//   REACTOR_URL   http://localhost:4001
//   UMH_API_URL   http://localhost:18081   the floor, as the REACTOR sees it
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_BLOCK,
  FIND_BLOCK,
  floorWorkflowGraph,
  LEDGER_TYPE,
  OPENROUTER_PIECE,
  PAPERLESS_PIECE,
  orderBindingWorkflowGraph,
  purchaseOrderWorkflowGraph,
  TRIGGER_BLOCK,
  UMH_PIECE,
} from "./graph.mjs";

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// demo/.env, read before anything below looks at process.env. Same place
// the umh-powerhouse demo keeps its keys, and the same reason: a credential
// belongs in a file you do not commit, not in a shell history. A variable
// already set in the environment wins, so `PAPERLESS_AI_API_KEY=… node seed.mjs`
// still works.
function loadEnvFile() {
  const file = path.join(demoRoot, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "" && process.env[match[1]] === undefined) {
      process.env[match[1]] = value;
    }
  }
}

loadEnvFile();

const REACTOR_URL = (process.env.REACTOR_URL ?? "http://localhost:4001").replace(/\/+$/, "");
const UMH_API_URL = (process.env.UMH_API_URL ?? "http://localhost:18081").replace(/\/+$/, "");

// Two drives, because they are read by different people. Ledgers live in the
// dashboard the ledger package ships; the workflow and the connection that
// drives them live with the other workflows, where Workflow Studio shows them.
//
// A drive's preferredEditor must target powerhouse/document-drive — that is the
// APP. The documents inside open in their own editors, because their
// documentTypes match.
const LEDGER_DRIVE = {
  name: "PL Dashboard",
  slug: "pl-dashboard",
  editor: "production-ledger-dashboard",
};
const WORKFLOW_DRIVE = {
  name: "Workflows",
  slug: "workflows",
  editor: "workflow-studio",
};

const LEDGER_PACKAGE = "umh-production-ledger";
// This project's own config: the reactor and Connect both run from here now,
// so there is one file rather than a sibling checkout's.
const CONNECT_CONFIG = path.resolve(demoRoot, "..", "powerhouse.config.json");
const CONNECTION_NAME = "UMH Factory Floor";
const WORKFLOW_NAME = "Append floor progress to the evidence trail";

const PAPERLESS_URL = (process.env.PAPERLESS_URL ?? "http://localhost:18000").replace(/\/+$/, "");
const PAPERLESS_USER = process.env.PAPERLESS_USER ?? "admin";
const PAPERLESS_PASSWORD = process.env.PAPERLESS_PASSWORD ?? "paperless";
const PAPERLESS_CONNECTION_NAME = "Paperless-ngx";
const PAPERLESS_DOCTYPE = "Purchase Order";
const AI_CONNECTION_NAME = "OpenRouter";
// The model the umh-powerhouse demo extracts with; any OpenRouter model id works.
const AI_MODEL = process.env.PAPERLESS_AI_MODEL ?? "openai/gpt-oss-120b";
// Optional: without it the connection is created empty and the key is pasted
// into Connect instead, which is the normal way to hand a reactor a credential.
// PAPERLESS_AI_API_KEY is the name the umh-powerhouse demo uses; OPENROUTER_API_KEY
// is accepted because that is what the key is.
const AI_API_KEY =
  process.env.PAPERLESS_AI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
const AI_SECRET_NAME = "api_key";
const PO_WORKFLOW_NAME = "Draft a ledger from a purchase order";
const BINDING_WORKFLOW_NAME = "Create the floor order on approval";

const log = (message) => console.log(message);

async function gql(query, variables = {}) {
  const response = await fetch(`${REACTOR_URL}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors[0].message}`);
  }
  return body.data;
}

// "Up" means the document models this script writes through are registered,
// not merely that something answers. The supergraph serves `__typename` while
// it is still composing, and a mutation sent in that window comes back as a
// bare 404 — which is how this first failed.
async function waitForReactor(seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  const NEEDED = ["Connection", "Workflow", "DocumentDrive"];
  for (;;) {
    try {
      const data = await gql(
        "{ __schema { mutationType { fields { name } } } }",
      );
      const fields = new Set(
        data.__schema.mutationType.fields.map((field) => field.name),
      );
      const missing = NEEDED.filter((name) => !fields.has(name));
      if (missing.length > 0) {
        throw new Error(`supergraph is still composing (no ${missing.join(", ")})`);
      }
      log(`reactor is up at ${REACTOR_URL}`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `No reactor at ${REACTOR_URL} after ${seconds}s. Start Vetra first:\n` +
            "  ./demo/start.sh\n" +
            `(last error: ${error.message})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// The floor is read by the reactor, not by this script, so the address checked
// here is the one the connection will carry — a floor this script can reach on
// a different address would be a connection that fails on first use.
async function checkFloor() {
  const response = await fetch(`${UMH_API_URL}/health`);
  if (!response.ok) throw new Error(`floor /health answered ${response.status}`);
  const simulation = await (await fetch(`${UMH_API_URL}/api/simulation`)).json();
  log(
    `floor is up at ${UMH_API_URL} (${simulation.line_count} lines, ${simulation.machine_count} machines)`,
  );
}

async function childrenOf(driveId) {
  const data = await gql(
    `query($id:String!) {
       documentOutgoingRelationships(
         sourceIdentifier:$id, relationshipType:"child", paging:{limit:200}) {
           items { id name documentType } } }`,
    { id: driveId },
  );
  return data.documentOutgoingRelationships.items;
}

// By name, because that is what a person reading Connect sees, and because a
// drive created by hand has its id for a slug. Matching on slug alone would
// have missed the Workflows drive somebody already had open.
async function findDrive(name) {
  const data = await gql(
    `query { findDocuments(search:{type:"powerhouse/document-drive"}, paging:{limit:100}) {
       items { id name slug state } } }`,
  );
  return data.findDocuments.items.find((item) => item.name === name);
}

async function ensureDrive(drive) {
  const existing = await findDrive(drive.name);
  if (existing) {
    log(`drive "${drive.name}" already exists (${existing.id})`);
    // Its own slug, not the one this script would have given it: a drive
    // created by hand in Connect has its id there, and that is what a default
    // drive URL has to address.
    return { id: existing.id, slug: existing.slug };
  }
  const created = await gql(
    `mutation($name:String!,$slug:String,$editor:String) {
       DocumentDrive { createDocument(name:$name, slug:$slug, preferredEditor:$editor) { id } } }`,
    { name: drive.name, slug: drive.slug, editor: drive.editor },
  );
  const id = created.DocumentDrive.createDocument.id;
  log(`created drive "${drive.name}" (${id})`);
  return { id, slug: drive.slug };
}



// Connect is the other half, and it is told none of this by the reactor: the
// browser fetches powerhouse.config.json over HTTP and reads its own `packages`
// and `defaultDrives` from there. Without the package entry the ledger
// documents render as an unknown type with no editor, however well the
// switchboard has loaded the same models.
//
// This edits a file that is tracked in git, and in this project that file
// already carries both entries — so a normal run prints "already carries" and
// writes nothing. It still writes when a drive was created by hand under a
// different slug, which is the case it exists for.
function configureConnect(drives) {
  // A deployment that hands Connect its config by environment — the
  // umh-powerhouse stack passes PH_CONNECT_CONFIG_JSON — has no file to edit,
  // and the drives it needs are already in that JSON. Nothing to do.
  if (!existsSync(CONNECT_CONFIG)) {
    log("no powerhouse.config.json here; Connect is configured by environment");
    return;
  }
  const config = JSON.parse(readFileSync(CONNECT_CONFIG, "utf8"));
  const changes = [];

  // This package is NOT named under `packages`. It used to be, so Connect would
  // resolve it against packageRegistryUrl — but Connect runs here as
  // `ph connect studio` from this very project, which loads the project's own
  // package locally (that is what --ignore-local turns off). Naming it as well
  // makes Connect first try to import it out of its own node_modules, where a
  // project is never installed, and then off the registry: two 404s in the
  // console before the local copy loads and everything works anyway.
  //
  // A deployment that runs Connect from a published build does need the entry —
  // the umh-powerhouse demo passes it through PH_CONNECT_CONFIG_JSON, not this
  // file — so this is about how the demo runs Connect, not about the package.
  if (config.packages?.some((entry) => entry.packageName === LEDGER_PACKAGE)) {
    config.packages = config.packages.filter(
      (entry) => entry.packageName !== LEDGER_PACKAGE,
    );
    changes.push(`packages -= ${LEDGER_PACKAGE} (loaded locally by connect studio)`);
  }

  config.connect ??= {};
  config.connect.drives ??= {};
  config.connect.drives.defaultDrives ??= [];
  const defaults = config.connect.drives.defaultDrives;
  // A drive is named here and its icon lives here too, in the committed
  // defaultDrives. Connect reconciles its default drives on every load and
  // setDriveMetadata forwards any icon that is not undefined, so this file is
  // what puts the marks on the drives — and why `"icon": null` must never
  // appear here, since that is forwarded as an explicit clear.
  for (const drive of drives) {
    const url = `${REACTOR_URL}/d/${drive.slug}`;
    if (!defaults.some((entry) => entry.url === url)) {
      defaults.push({ url });
      changes.push(`defaultDrives += ${url}`);
    }
  }

  if (changes.length === 0) {
    log("Connect config already names both drives and their icons");
    return;
  }
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(CONNECT_CONFIG, serialized);
  // Connect is served from a build (`ph connect preview`), and a build bakes
  // its own copy of this file. Writing only the source would leave the running
  // SPA on the config it was built with — the drives' icons above are exactly
  // the kind of thing that then silently does not appear. `ph connect config`
  // dual-writes for the same reason; this does what it does.
  const built = path.resolve(demoRoot, "..", ".ph", "connect-build", "dist", "powerhouse.config.json");
  if (existsSync(built)) {
    writeFileSync(built, serialized);
    log("connect config: updated the built copy too (refresh Connect)");
  }
  for (const change of changes) log(`connect config: ${change}`);
  // Both halves take effect now: `ph vetra` merges this file's defaultDrives
  // with the Vetra drive instead of replacing them, so a drive named here is
  // one Connect opens on its next load. The package entry needs a reload.
  log("Reload Connect to pick up the package and the drives.");
}


// ---- paperless -------------------------------------------------------------

async function paperless(path, init = {}, token) {
  const response = await fetch(`${PAPERLESS_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Token ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`paperless ${init.method ?? "GET"} ${path} -> ${response.status}`);
  }
  return response.status === 204 ? undefined : response.json();
}

// Minted rather than configured: the demo's paperless has a known admin login
// and no token until something asks for one.
async function paperlessToken(seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const body = await paperless("/api/token/", {
        method: "POST",
        body: JSON.stringify({ username: PAPERLESS_USER, password: PAPERLESS_PASSWORD }),
      });
      log(`paperless is up at ${PAPERLESS_URL}`);
      return body.token;
    } catch (error) {
      // A login paperless actively rejects will never start working; only a
      // stack still converging is worth waiting for.
      if (/-> 40[013]$/.test(error.message)) {
        throw new Error(
          `${error.message} — check PAPERLESS_ADMIN_USER / PAPERLESS_ADMIN_PASSWORD in demo/docker-compose.yml`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`No paperless at ${PAPERLESS_URL} after ${seconds}s (${error.message})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// The type the trigger filters on. Paperless assigns it by matching the word
// "order" anywhere in the document (matching_algorithm 1 = any word), so a
// dropped purchase order is classified before the webhook fires.
async function ensureDocumentType(token) {
  const existing = await paperless(
    `/api/document_types/?name__iexact=${encodeURIComponent(PAPERLESS_DOCTYPE)}`,
    {},
    token,
  );
  if (existing.results?.length) {
    log(`paperless document type "${PAPERLESS_DOCTYPE}" already exists (${existing.results[0].id})`);
    return existing.results[0].id;
  }
  const created = await paperless(
    "/api/document_types/",
    {
      method: "POST",
      body: JSON.stringify({
        name: PAPERLESS_DOCTYPE,
        matching_algorithm: 1,
        match: "order",
        is_insensitive: true,
      }),
    },
    token,
  );
  log(`created paperless document type "${PAPERLESS_DOCTYPE}" (${created.id})`);
  return created.id;
}

// ---- connections -----------------------------------------------------------

// The value never comes back out: createSecret stores it encrypted and returns
// a ref, and the connection document holds only the ref.
async function mintSecret(value, label) {
  const data = await gql(
    `mutation($value:String!,$label:String) {
       workflowRuntime { createSecret(value:$value, label:$label) { ref } } }`,
    { value, label },
  );
  return data.workflowRuntime.createSecret.ref;
}

async function ensurePaperlessConnection(driveId, token) {
  const existing = (await childrenOf(driveId)).find(
    (item) =>
      item.documentType === "powerhouse/connection" &&
      item.name === PAPERLESS_CONNECTION_NAME,
  );
  if (existing) {
    log(`connection "${PAPERLESS_CONNECTION_NAME}" already exists (${existing.id})`);
    return existing.id;
  }
  const created = await gql(
    `mutation($name:String!,$parent:String) {
       Connection { createDocument(name:$name, parentIdentifier:$parent) { id } } }`,
    { name: PAPERLESS_CONNECTION_NAME, parent: driveId },
  );
  const id = created.Connection.createDocument.id;
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConnectorInput!) {
       Connection { setConnector(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { connectorId: PAPERLESS_PIECE, authType: "CUSTOM_AUTH" } },
  );
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConfigInput!) {
       Connection { setConfig(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { config: { base_url: PAPERLESS_URL } } },
  );
  const ref = await mintSecret(token, `${PAPERLESS_CONNECTION_NAME} API token`);
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetSecretRefInput!) {
       Connection { setSecretRef(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { id: randomUUID(), name: "token", ref } },
  );
  log(`created connection "${PAPERLESS_CONNECTION_NAME}" -> ${PAPERLESS_URL} (${id})`);
  return id;
}

// The extractor's credential. Left empty unless an API key is in the
// environment: a key belongs to whoever runs the demo, and Connect's connection
// editor is where one is normally pasted.
async function connectionState(id) {
  const data = await gql(
    `query($id:String!) {
       Connection { document(identifier:$id) { document { state { global {
         connectorId authType secretRefs { id name ref } } } } } } }`,
    { id },
  );
  return data.Connection.document.document.state.global;
}

// SECRET_TEXT: one secret and nothing else, which is what the piece reads as
// auth.secret_text. The connector is the package without its version.
async function setAiConnector(connectionId) {
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConnectorInput!) {
       Connection { setConnector(docId:$doc, input:$input) { id } } }`,
    { doc: connectionId, input: { connectorId: OPENROUTER_PIECE, authType: "SECRET_TEXT" } },
  );
}

// The key behind the connection, set or replaced from the environment.
//
// Rotating rather than re-minting when a ref already exists is what
// `rotateSecret` is for: the value behind the ref changes and the connection
// document is not touched, so nothing that referenced it has to be rewritten.
async function setApiKey(connectionId, key) {
  const state = await connectionState(connectionId);
  const existing = state.secretRefs?.find((entry) => entry.name === AI_SECRET_NAME);
  if (existing) {
    await gql(
      `mutation($ref:String!,$value:String!) {
         workflowRuntime { rotateSecret(ref:$ref, value:$value) { ref } } }`,
      { ref: existing.ref, value: key },
    );
    log(`rotated the ${AI_CONNECTION_NAME} API key from the environment`);
    return;
  }
  const ref = await mintSecret(key, `${AI_CONNECTION_NAME} API key`);
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetSecretRefInput!) {
       Connection { setSecretRef(docId:$doc, input:$input) { id } } }`,
    { doc: connectionId, input: { id: randomUUID(), name: AI_SECRET_NAME, ref } },
  );
  log(`set the ${AI_CONNECTION_NAME} API key from the environment`);
}

// The extractor's credential. The key comes from demo/.env (or the
// environment); without one the connection is created empty and the extraction
// step has nothing to authenticate with, which the summary says out loud.
async function ensureAiConnection(driveId) {
  const existing = (await childrenOf(driveId)).find(
    (item) =>
      item.documentType === "powerhouse/connection" && item.name === AI_CONNECTION_NAME,
  );
  if (existing) {
    log(`connection "${AI_CONNECTION_NAME}" already exists (${existing.id})`);
    // Repaired, not just reused: a connection carrying the wrong connectorId
    // is refused at run time with "Connection is not available to this block",
    // and re-running the seed is the obvious thing to try when that happens.
    const state = await connectionState(existing.id);
    if (state.connectorId !== OPENROUTER_PIECE) {
      await setAiConnector(existing.id);
      log(`repaired its connector: ${state.connectorId} -> ${OPENROUTER_PIECE}`);
    }
    // Re-running with a key now set is how a demo gets one: the connection is
    // already there, and skipping it would silently ignore the key.
    if (AI_API_KEY) await setApiKey(existing.id, AI_API_KEY);
    return existing.id;
  }
  const created = await gql(
    `mutation($name:String!,$parent:String) {
       Connection { createDocument(name:$name, parentIdentifier:$parent) { id } } }`,
    { name: AI_CONNECTION_NAME, parent: driveId },
  );
  const id = created.Connection.createDocument.id;
  await setAiConnector(id);
  log(`created connection "${AI_CONNECTION_NAME}" (${id})`);
  if (AI_API_KEY) await setApiKey(id, AI_API_KEY);
  return id;
}

async function ensureConnection(driveId) {
  const existing = (await childrenOf(driveId)).find(
    (item) =>
      item.documentType === "powerhouse/connection" && item.name === CONNECTION_NAME,
  );
  if (existing) {
    log(`connection "${CONNECTION_NAME}" already exists (${existing.id})`);
    return existing.id;
  }
  const created = await gql(
    `mutation($name:String!,$parent:String) {
       Connection { createDocument(name:$name, parentIdentifier:$parent) { id } } }`,
    { name: CONNECTION_NAME, parent: driveId },
  );
  const id = created.Connection.createDocument.id;
  // The floor API has no credential, so the connection is an address and
  // nothing else: no secret ref, and no secrets service involved.
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConnectorInput!) {
       Connection { setConnector(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { connectorId: UMH_PIECE, authType: "CUSTOM_AUTH" } },
  );
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConfigInput!) {
       Connection { setConfig(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { config: { base_url: UMH_API_URL } } },
  );
  log(`created connection "${CONNECTION_NAME}" -> ${UMH_API_URL} (${id})`);
  return id;
}

// `createDocument(name:)` names the DOCUMENT; a workflow's own state.name is a
// separate field that starts empty. The runtime stamps every run with
// state.name, so leaving it unset is what made the workflow column blank in
// Studio's run table while the drive listed the name perfectly well.
async function ensureWorkflowName(id, name) {
  await gql(
    `mutation($doc:PHID!,$input:Workflow_SetWorkflowNameInput!) {
       Workflow { setWorkflowName(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { name } },
  );
}

// Both workflows are published the same way; only the graph differs.
async function publishWorkflow(driveId, name, graph) {
  const existing = (await childrenOf(driveId)).find(
    (item) => item.documentType === "powerhouse/workflow" && item.name === name,
  );
  if (existing) {
    log(`workflow "${name}" already exists (${existing.id}) — delete it to rebuild`);
    // The graph is left alone, but the name is cheap to put right: a workflow
    // seeded before this was set records "" against every run it has since run.
    await ensureWorkflowName(existing.id, name);
    return existing.id;
  }
  const created = await gql(
    `mutation($name:String!,$parent:String) {
       Workflow { createDocument(name:$name, parentIdentifier:$parent) { id } } }`,
    { name, parent: driveId },
  );
  const id = created.Workflow.createDocument.id;
  await ensureWorkflowName(id, name);
  await gql(
    `mutation($doc:PHID!,$input:Workflow_SetTriggerInput!) {
       Workflow { setTrigger(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: graph.trigger },
  );
  for (const step of graph.steps) {
    await gql(
      `mutation($doc:PHID!,$input:Workflow_AddStepInput!) {
         Workflow { addStep(docId:$doc, input:$input) { id } } }`,
      { doc: id, input: step },
    );
  }
  for (const edge of graph.edges) {
    await gql(
      `mutation($doc:PHID!,$input:Workflow_AddEdgeInput!) {
         Workflow { addEdge(docId:$doc, input:$input) { id } } }`,
      { doc: id, input: edge },
    );
  }
  // Last, deliberately: only an ENABLED workflow registers a trigger instance,
  // and a half-built graph that starts polling — or registers a webhook with
  // paperless — would run against missing steps.
  await gql(
    `mutation($doc:PHID!,$input:Workflow_SetWorkflowStatusInput!) {
       Workflow { setWorkflowStatus(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { status: "ENABLED" } },
  );
  log(`created workflow "${name}" (${id}) — ${graph.steps.length} steps, ENABLED`);
  return id;
}

await waitForReactor();
await checkFloor();
const ledgerDrive = await ensureDrive(LEDGER_DRIVE);
const workflowDrive = await ensureDrive(WORKFLOW_DRIVE);

// Track A — the floor.
const umhConnectionId = await ensureConnection(workflowDrive.id);
const floorWorkflowId = await publishWorkflow(
  workflowDrive.id,
  WORKFLOW_NAME,
  floorWorkflowGraph(umhConnectionId),
);

// Track B — the purchase order. Paperless first, because the connection needs
// a token it mints and the trigger filters on a type it holds.
const token = await paperlessToken();
const documentTypeId = await ensureDocumentType(token);
const paperlessConnectionId = await ensurePaperlessConnection(workflowDrive.id, token);
const aiConnectionId = await ensureAiConnection(workflowDrive.id);
const poWorkflowId = await publishWorkflow(
  workflowDrive.id,
  PO_WORKFLOW_NAME,
  purchaseOrderWorkflowGraph({
    paperlessConnectionId,
    aiConnectionId,
    umhConnectionId,
    ledgerDriveId: ledgerDrive.id,
    documentTypeId,
    model: AI_MODEL,
  }),
);

// Track C — the approval. The editor dispatches APPROVE_ORDER and this
// creates the floor order the ledger then opens against.
const bindingWorkflowId = await publishWorkflow(
  workflowDrive.id,
  BINDING_WORKFLOW_NAME,
  orderBindingWorkflowGraph({ umhConnectionId }),
);

configureConnect([workflowDrive, ledgerDrive]);

log(`
Seeded.

  ledger drive    ${ledgerDrive.id}   (${LEDGER_DRIVE.name})
  workflow drive  ${workflowDrive.id}   (${WORKFLOW_DRIVE.name})

  connections     ${umhConnectionId}  ${CONNECTION_NAME}
                  ${paperlessConnectionId}  ${PAPERLESS_CONNECTION_NAME}
                  ${aiConnectionId}  ${AI_CONNECTION_NAME}${AI_API_KEY ? "" : "  <- needs an API key"}

  workflows       ${floorWorkflowId}  ${WORKFLOW_NAME}
                  ${poWorkflowId}  ${PO_WORKFLOW_NAME}
                  ${bindingWorkflowId}  ${BINDING_WORKFLOW_NAME}

Connect opens both drives on its next load: ph vetra merges
connect.drives.defaultDrives with the Vetra drive rather than replacing it, and
powerhouse.config.json already names these two. A drive created under a
different slug than the config's needs the config updating — this run wrote any
that were missing. Direct links, if you want one now:

  ${WORKFLOW_DRIVE.name}: http://localhost:3001/?driveUrl=${encodeURIComponent(`${REACTOR_URL}/d/${workflowDrive.slug}`)}
  ${LEDGER_DRIVE.name}: http://localhost:3001/?driveUrl=${encodeURIComponent(`${REACTOR_URL}/d/${ledgerDrive.slug}`)}

Next:${AI_API_KEY ? "" : `
  0. Open the "${AI_CONNECTION_NAME}" connection in Connect and paste an
     OpenRouter API key — or put it in demo/.env as
     PAPERLESS_AI_API_KEY and run this script again.`}
  1. Drop a purchase-order PDF into paperless (${PAPERLESS_URL}, ${PAPERLESS_USER}
     / ${PAPERLESS_PASSWORD}). It must contain the word "order", which is what
     classifies it as a "${PAPERLESS_DOCTYPE}" and fires the webhook.
  2. A DRAFT ledger appears in "${LEDGER_DRIVE.name}" with the commitment
     extracted and the scan attached. Review it, correct what the model got
     wrong, then Approve and Open it — that is the human gate, and the
     workflows never cross it.
  3. Put a floor order id in its Order ID, or approve to create one, and the
     floor workflow starts appending evidence within a poll interval.
  4. Watch the runs:
     curl -s ${REACTOR_URL}/graphql/workflow-runtime \\
       -H 'content-type: application/json' \\
       -d '{"query":"{ workflowRuntime { runs(limit: 5) { workflowName status steps { stepKey status } } } }"}'
`);
