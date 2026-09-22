// The workflow that replaces the `umh-order-poller` processor, as data.
//
// Kept apart from the seeding so it can be run against the engine directly:
// test/workflow-graph.test.mjs feeds it a real trigger payload and asserts what
// reaches the ledger. The shape is both the document actions the seed
// dispatches and the engine's own WorkflowDefinition, which is why the test can
// hand it straight to runWorkflow.
import { randomUUID } from "node:crypto";

export const LEDGER_TYPE = "umh/production-ledger";
export const UMH_PIECE = "@powerhousedao/piece-umh";
export const PAPERLESS_PIECE = "@powerhousedao/piece-paperless-ngx";
// The package, and the version-pinned form its block types carry.
//
// A connection stores the PACKAGE: the runtime checks a step's piece against
// its connection's connectorId (packageFromConnectorId strips a "#suffix" and
// nothing else), so a version in there never matches and the step is refused
// its credential — "Connection is not available to this block".
export const OPENROUTER_PIECE = "@activepieces/piece-open-router";
export const OPENROUTER_PINNED = `${OPENROUTER_PIECE}@0.2.0`;
export const PAPERLESS_PINNED = `${PAPERLESS_PIECE}@0.1.0`;
export const REACTOR_PIECE = "@powerhousedao/piece-reactor";

// Two kinds of piece, and the difference decides whether a version belongs in
// the block type (pieces/engine/blocks.ts, parseBlockType):
//
// - A piece this reactor holds locally — the UMH piece ships inside this
//   package, the reactor piece inside the runtime — is named WITHOUT a version.
//   The installed copy is the one that runs, so a workflow naming it survives
//   an upgrade. Unversioned resolves only against the local piece registry.
// - A piece that comes from the package registry is named WITH one. An
//   unversioned name the reactor does not hold locally does not resolve, and
//   the failure is silent: pieceBinding returns undefined, the trigger is never
//   supervised, and it reports armed=false with no error anywhere. Pinning is
//   what lets the runtime fetch it, so paperless needs no `packages` entry in
//   powerhouse.config.json.
// The UMH piece ships inside this package and is named without a version. A
// reactor running from the checkout holds it; one that INSTALLS this package
// from a registry now keeps its pieces too (powerhouse-inc/powerhouse#3071), so
// the name resolves to the version the package shipped either way \u2014 and a local
// change still takes effect without republishing.
export const TRIGGER_BLOCK = `${UMH_PIECE}#trigger:order_progressed`;
export const FIND_BLOCK = `${REACTOR_PIECE}#document-find`;
export const DISPATCH_BLOCK = `${REACTOR_PIECE}#document-dispatch`;
export const NEW_DOCUMENT_BLOCK = `${PAPERLESS_PINNED}#trigger:new_document`;
export const GET_FILE_BLOCK = `${PAPERLESS_PINNED}#get_document_file`;
export const SCHEMA_BLOCK = `${REACTOR_PIECE}#document-schema`;
export const CREATE_BLOCK = `${REACTOR_PIECE}#document-create`;
export const ASK_LLM_BLOCK = `${OPENROUTER_PINNED}#ask-lmm`;
export const GET_BLOCK = `${REACTOR_PIECE}#document-get`;
export const DOCUMENT_EVENT_BLOCK = `${REACTOR_PIECE}#trigger:document-event`;
export const CREATE_ORDER_BLOCK = `${UMH_PIECE}#create_order`;
export const LIST_LINES_BLOCK = `${UMH_PIECE}#list_lines`;
// Stock activepieces utility, version-pinned like every other registry piece.
export const JSONATA_BLOCK = "@activepieces/piece-json@0.1.12#run_jsonata_query";

// The workflow that replaces the processor.
//
//   order progressed ─▶ counted? ─true─▶ find the bound ledger ─▶ open? ─true─▶ snapshot
//
// Two guards, and each one is load-bearing:
//
// `counted` is the piece's own flag for "the floor has counted something".
// Without it the first firing of every order — the PENDING -> RUNNING
// transition, with nothing produced — would write an empty reading at the head
// of the trail, and the ledger's `qualityPct` is non-null, so it would have to
// be given a quality nobody measured.
//
// `open` is the binding the processor did in code: a ledger that is not OPEN
// has either not frozen its baseline yet or has already closed out, and
// evidence appended outside that window is evidence against a commitment that
// was not in force.
export function floorWorkflowGraph(connectionId) {
  const triggerId = randomUUID();
  const counted = randomUUID();
  const find = randomUUID();
  const open = randomUUID();
  const snapshot = randomUUID();
  return {
    trigger: {
      id: triggerId,
      blockType: TRIGGER_BLOCK,
      connectionId,
      config: {
        include_oee: true,
        // Ours, not the piece's: the runtime lifts it out of the config before
        // the piece sees it. 15s is the cadence the processor this workflow
        // replaces polled at, and the pace a demo needs — a two-minute run
        // with a reading a minute looks like nothing is happening. It is also
        // the runtime's floor (MIN_SCHEDULE_INTERVAL_MS), so this is as fast
        // as a polling trigger goes.
        pollEverySeconds: 15,
      },
    },
    steps: [
      {
        id: counted,
        key: "counted",
        name: "Has the floor counted anything?",
        blockType: "core#branch",
        config: { condition: "{{trigger.payload.counted}}" },
        position: { x: 320, y: 0 },
      },
      {
        id: find,
        key: "ledger",
        name: "Find the ledger bound to this order",
        blockType: FIND_BLOCK,
        config: {
          documentType: LEDGER_TYPE,
          // The index cannot query state, so the host matches within the page
          // it read; 100 is its cap.
          matchPath: "orderId",
          matchValue: "{{trigger.payload.orderId}}",
          includeState: true,
          limit: 100,
        },
        position: { x: 640, y: 0 },
      },
      {
        id: open,
        key: "open",
        name: "Is that ledger OPEN?",
        blockType: "core#branch",
        config: {
          condition: "{{steps.ledger.output.documents.0.state.status}}",
          equals: "OPEN",
        },
        position: { x: 960, y: 0 },
      },
      {
        id: snapshot,
        key: "snapshot",
        name: "Append the evidence snapshot",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.ledger.output.documents.0.documentId}}",
          documentType: LEDGER_TYPE,
          // Enforced by the step, not merely suggested: this workflow appends
          // evidence and must not be able to do anything else to the ledger.
          allowedActions: "RECORD_ACTUALS_SNAPSHOT",
          actions: [
            {
              type: "RECORD_ACTUALS_SNAPSHOT",
              input: {
                // Derived rather than random, so replaying a delivery writes
                // the same snapshot id — and the reducer rejects a duplicate
                // instead of appending the same reading twice.
                id: "{{trigger.payload.orderId}}-{{trigger.payload.capturedAt}}",
                capturedAt: "{{trigger.payload.capturedAt}}",
                quantityCompleted: "{{trigger.payload.quantityCompleted}}",
                quantityScrap: "{{trigger.payload.quantityScrap}}",
                // Guaranteed a number by the `counted` guard above.
                qualityPct: "{{trigger.payload.qualityPct}}",
                oeePct: "{{trigger.payload.oeePct}}",
                availabilityPct: "{{trigger.payload.availabilityPct}}",
                performancePct: "{{trigger.payload.performancePct}}",
                floorStatus: "{{trigger.payload.lifecycle}}",
                floorStatusRaw: "{{trigger.payload.statusRaw}}",
                floorCompletedAt: "{{trigger.payload.closedAt}}",
              },
            },
          ],
        },
        position: { x: 1280, y: 0 },
      },
    ],
    edges: [
      { id: randomUUID(), from: triggerId, to: counted, port: "next" },
      { id: randomUUID(), from: counted, to: find, port: "true" },
      { id: randomUUID(), from: find, to: open, port: "next" },
      { id: randomUUID(), from: open, to: snapshot, port: "true" },
    ],
  };
}


// What the extractor is told. Lifted in substance from the processor this
// replaces (its SYSTEM_PROMPT and the demo's mapping instructions), because the
// rules in it were learned from real scans rather than reasoned about:
//
// - the model's own schema and operation list are handed over at run time by
//   the step before this one, so the prompt cannot drift from the document
//   model the way a hardcoded field list would;
// - OCR text is noisy, and repairing an obvious mis-scan beats refusing;
// - never invent a value — an absent field is absent, and a ledger is a
//   contract;
// - and the human gate: the extractor fills the commitment and stops. A
//   reviewer approves, opens and signs. That last rule is also enforced by the
//   step that dispatches these actions, which accepts SET_COMMITMENT and
//   nothing else, so a model that ignores the instruction still cannot open a
//   ledger.
const EXTRACTION_PROMPT = [
  "You convert OCR text from a scanned purchase order into actions on a Powerhouse document.",
  "",
  "The target document model is umh/production-ledger. Its state schema:",
  "{{steps.model.output.stateSchema}}",
  "",
  "The one operation you may use, with its GraphQL input schema:",
  "{{steps.model.output.actions}}",
  "",
  "The scanned document:",
  "Title: {{trigger.payload.title}}",
  "Created: {{trigger.payload.created}}",
  "OCR text:",
  "{{trigger.payload.content}}",
  "",
  "Respond with a single JSON object and nothing else — no prose, no markdown fences:",
  '{"actions": [{"type": "SET_COMMITMENT", "input": { ... }}]}',
  "",
  "Rules:",
  "- Use SET_COMMITMENT and nothing else. Never approve, open, start, close or sign:",
  "  a human reviews this draft, and the ledger locks its commitment once opened.",
  "- The input must conform to SetCommitmentInput above. Omit every field you have",
  "  no data for. Never invent a value.",
  "- Dates are full ISO 8601 UTC, e.g. 2026-09-30T00:00:00.000Z. Currency is an ISO",
  "  4217 code such as EUR, and it goes in `currency` \u2014 once, for the whole order.",
  "- Every amount is a plain JSON number and never an object. `scrapLiabilityPerUnit`",
  "  and `latePenaltyPerHour` are the two this is usually got wrong on:",
  '  write "latePenaltyPerHour": 250, never {"amount": 250, "currency": "EUR"}.',
  "  An amount written as an object is rejected outright and the whole commitment",
  "  is lost, including every field you got right.",
  "- Quantities are integers.",
  "- OCR text is noisy (\"fiir\" is \"für\", \"MusterstraBe\" is \"Musterstraße\"):",
  "  repair an obvious mis-scan when the intent is clear.",
  "- Leave orderId unset. Nothing has been dispatched to the floor yet; a reviewer",
  "  approves the ledger and that is what creates the order.",
  "- Leave line unset. It names a production line on the factory floor, not the",
  "  programme or platform the order refers to; you cannot see the floor and its",
  "  names are not in this document. A later step reads the live list and picks",
  "  from it, and a reviewer still has the last word.",
].join("\n");

// Picking the line is a different job from reading the purchase order, and it
// gets its own prompt for the reason the extraction cannot do it: the answer is
// not in the document. It is in the floor's own list of lines and the parts each
// one runs, so the model is given that list and asked to name a pair from it.
//
// The model's answer is never written anywhere. It is a search key: the step
// after this one looks for a line id and a part id INSIDE the answer and returns
// the ones it finds in the floor's list. So a name the model invents matches
// nothing and is dropped, and what reaches the ledger always came from the floor.
// That is a stronger guarantee than checking the answer is non-empty, which
// cannot tell a real line from a plausible-looking one.
const ASSIGNMENT_PROMPT = [
  "You match a purchase order to a line on a factory floor.",
  "",
  "The commitment just extracted from the customer's purchase order:",
  "{{steps.extract.output}}",
  "",
  "The lines on the floor right now, each with the parts it can run:",
  "{{steps.lines.output}}",
  "",
  "Name the line that should run this order and the part it should run, as:",
  '{"line": "<instance_id>", "partNumber": "<product_id>"}',
  "",
  "Rules:",
  "- Copy both values exactly from the list above. `partNumber` must be a part of",
  "  the line you named \u2014 a part from another line is not a match.",
  "- Match on the order's part number first. It often already is one of the",
  "  product ids. Otherwise match its part description against the parts'",
  "  descriptions and the line's template name.",
  "- If no line on this floor can run this part, say so in plain words and name",
  "  nothing. A reviewer then picks it by hand. A wrong line is worse than none:",
  "  the order would be created on a line that cannot build the part.",
].join("\n");

// Deterministic, and the reason the model's answer is safe to act on. It reads
// the floor's list and the model's answer, finds the line whose id the answer
// mentions, then the part whose id the answer mentions AMONG THAT LINE'S OWN
// recipes, and returns the pair from the list rather than from the answer.
// Anything else \u2014 an invented line, a real part on the wrong line, a refusal
// \u2014 returns {} and the assignment is skipped.
const ASSIGNMENT_QUERY =
  "($a := $string(answer); " +
  "$line := (lines[$contains($a, instance_id)])[0]; " +
  "$part := ($line.recipes[$contains($a, product_id)])[0]; " +
  "($exists($line) and $exists($part)) " +
  "? {'line': $line.instance_id, 'partNumber': $part.product_id} : {})";

// The workflow that replaces the `paperless-sync` processor.
//
//   new document ─▶ purchase order? ─true─▶ read the model ─▶ extract
//                    ─▶ draft ─▶ commitment ─▶ fetch scan ─▶ attach
//                    ─▶ list the floor's lines ─▶ ask which line and part
//                    ─▶ resolve it against the floor ─▶ real line? ─true─▶ apply it
//
// The processor did this with an engine: an LLM client, an import store, a
// safe-merge, a paperless client and a docling client. The same result here is
// twelve blocks, and three of them are the reactor's own.
//
// Why the draft and the commitment are separate steps: `document-create` will
// dispatch the actions in a payload, but only `document-dispatch` enforces an
// allow-list. Creating the document empty and dispatching into it is what makes
// "SET_COMMITMENT and nothing else" a rule rather than a request, which matters
// when the actions were written by a model.
export function purchaseOrderWorkflowGraph({
  paperlessConnectionId,
  aiConnectionId,
  umhConnectionId,
  ledgerDriveId,
  documentTypeId,
  model,
}) {
  const triggerId = randomUUID();
  const kind = randomUUID();
  const schema = randomUUID();
  const extract = randomUUID();
  const draft = randomUUID();
  const commit = randomUUID();
  const lines = randomUUID();
  const choose = randomUUID();
  const resolve = randomUUID();
  const matched = randomUUID();
  const assign = randomUUID();
  const file = randomUUID();
  const attach = randomUUID();
  return {
    trigger: {
      id: triggerId,
      blockType: NEW_DOCUMENT_BLOCK,
      connectionId: paperlessConnectionId,
      config: {
        // The piece translates this to 2.18's singular
        // `filter_has_document_type`, so paperless filters the delivery at
        // the source and applies the same filter to the reconciliation
        // sweep. (It did not always: the 3.x name went over as-is, DRF
        // dropped it, and the guard below was what actually decided.)
        ...(documentTypeId ? { filter_has_any_document_types: [documentTypeId] } : {}),
        // The OCR text is the input to the extraction; without this the
        // trigger omits it, and it is usually the largest field paperless has.
        include_content: true,
      },
    },
    steps: [
      {
        id: kind,
        key: "purchase_order",
        name: "Is it a purchase order?",
        // Redundant now that the trigger filters, and kept: it is the same
        // decision written where a reader of the workflow can see it, and it
        // still holds if the trigger is reconfigured or its filter cleared.
        blockType: "core#branch",
        config: {
          condition: "{{trigger.payload.document_type}}",
          // Compared as text: every expression resolves to a string, and the
          // branch normalises both sides before comparing.
          equals: documentTypeId === undefined ? "" : String(documentTypeId),
        },
        position: { x: 320, y: 0 },
      },
      {
        id: schema,
        key: "model",
        name: "Read the ledger's own schema",
        blockType: SCHEMA_BLOCK,
        config: {
          documentType: LEDGER_TYPE,
          // Narrowed to the one operation the extractor may use. The whole
          // list is eleven operations of GraphQL input schema, most of which
          // exist to close out or sign a ledger — sending them invites a model
          // to reach for one, and makes the prompt several times larger than
          // the document it is reading.
          actionType: "SET_COMMITMENT",
        },
        position: { x: 640, y: 0 },
      },
      {
        id: extract,
        key: "extract",
        name: "Extract the commitment",
        blockType: ASK_LLM_BLOCK,
        connectionId: aiConnectionId,
        config: { model, prompt: EXTRACTION_PROMPT, temperature: 0 },
        // The host's default is 30s, and a model reading a page of OCR and
        // answering with JSON regularly takes longer — especially a large one
        // behind a router that may queue the request.
        timeoutSeconds: 180,
        position: { x: 960, y: 0 },
      },
      {
        id: draft,
        key: "draft",
        name: "Create the draft ledger",
        blockType: CREATE_BLOCK,
        config: {
          documentType: LEDGER_TYPE,
          parentId: ledgerDriveId,
          // The scan's own title, not the model's: a reviewer looking for this
          // ledger is looking for the purchase order it came from.
          name: "{{trigger.payload.title}}",
        },
        position: { x: 1280, y: 0 },
      },
      {
        id: commit,
        key: "commitment",
        name: "Apply the extracted commitment",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.draft.output.documentId}}",
          documentType: LEDGER_TYPE,
          // The gate, enforced rather than requested.
          allowedActions: "SET_COMMITMENT",
          actions: "{{steps.extract.output}}",
        },
        position: { x: 1600, y: 0 },
      },
      {
        id: file,
        key: "scan",
        name: "Fetch the original scan",
        blockType: GET_FILE_BLOCK,
        connectionId: paperlessConnectionId,
        config: {
          id: "{{trigger.payload.id}}",
          // The archived copy is the OCR'd PDF; it is what a reviewer wants to
          // read beside the extraction.
          variant: "archive",
        },
        position: { x: 2880, y: 0 },
      },
      {
        id: attach,
        key: "attach",
        name: "Attach the scan to the ledger",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.draft.output.documentId}}",
          documentType: LEDGER_TYPE,
          allowedActions: "SET_SOURCE_DOCUMENT",
          actions: [
            {
              type: "SET_SOURCE_DOCUMENT",
              input: {
                // An attachment reference, not bytes: the file lives in the
                // attachment store and only the reference enters the journal.
                sourceDocument: "{{steps.scan.output.ref}}",
                fileName: "{{steps.scan.output.filename}}",
              },
            },
          ],
        },
        position: { x: 2240, y: 0 },
      },
      {
        id: lines,
        key: "lines",
        name: "List the floor's lines",
        blockType: LIST_LINES_BLOCK,
        connectionId: umhConnectionId,
        config: {},
        position: { x: 2560, y: 0 },
      },
      {
        id: choose,
        key: "choose",
        name: "Ask which line and part",
        blockType: ASK_LLM_BLOCK,
        connectionId: aiConnectionId,
        config: { model, prompt: ASSIGNMENT_PROMPT, temperature: 0 },
        // Same reason as the extraction: a model behind a router queues.
        timeoutSeconds: 180,
        position: { x: 2880, y: 0 },
      },
      {
        id: resolve,
        key: "resolve",
        name: "Resolve it against the floor",
        blockType: JSONATA_BLOCK,
        config: {
          json: {
            lines: "{{steps.lines.output.lines}}",
            answer: "{{steps.choose.output}}",
          },
          query: ASSIGNMENT_QUERY,
        },
        position: { x: 3200, y: 0 },
      },
      {
        id: matched,
        key: "matched",
        name: "Did it resolve to a real line?",
        blockType: "core#branch",
        config: { condition: "{{steps.resolve.output.line}}" },
        position: { x: 3520, y: 0 },
      },
      {
        id: assign,
        key: "assignment",
        name: "Apply the line and part",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.draft.output.documentId}}",
          documentType: LEDGER_TYPE,
          // The same gate the extraction goes through, and the payload is ours:
          // the two values are read out of the resolve step, which took them
          // from the floor's own list. SET_COMMITMENT merges — the reducer only
          // overwrites fields the input carries — so this adds the line and the
          // part without disturbing what was read off the purchase order.
          allowedActions: "SET_COMMITMENT",
          actions: [
            {
              type: "SET_COMMITMENT",
              input: {
                line: "{{steps.resolve.output.line}}",
                partNumber: "{{steps.resolve.output.partNumber}}",
              },
            },
          ],
        },
        position: { x: 3840, y: 0 },
      },
    ],
    edges: [
      { id: randomUUID(), from: triggerId, to: kind, port: "next" },
      { id: randomUUID(), from: kind, to: schema, port: "true" },
      { id: randomUUID(), from: schema, to: extract, port: "next" },
      { id: randomUUID(), from: extract, to: draft, port: "next" },
      { id: randomUUID(), from: draft, to: commit, port: "next" },
      { id: randomUUID(), from: commit, to: file, port: "next" },
      { id: randomUUID(), from: file, to: attach, port: "next" },
      { id: randomUUID(), from: attach, to: lines, port: "next" },
      { id: randomUUID(), from: lines, to: choose, port: "next" },
      { id: randomUUID(), from: choose, to: resolve, port: "next" },
      { id: randomUUID(), from: resolve, to: matched, port: "next" },
      // No "false" edge: nothing matched, so the ledger keeps the reviewer's
      // blocker and the run ends having still drafted and attached the scan.
      { id: randomUUID(), from: matched, to: assign, port: "true" },
    ],
  };
}


// The workflow that takes the floor order off the editor's hands.
//
//   approved ─▶ read the ledger ─▶ already bound? ─false─▶ create the order ─▶ bind + open
//                                                               └──error──▶ record why not
//
// The editor used to POST to the factory itself and pass the minted id into
// the approval. A browser has no business talking to a factory: the reactor is
// the side holding the UMH connection, its key behind a secret ref and the
// egress policy piece code runs under. So the editor now dispatches an
// ordinary APPROVE_ORDER and this reacts to it.
//
// It reacts rather than polls: the reactor's document triggers are fed by the
// workflow-triggers read model, which sees every operation as it lands. The
// piece declares them as POLLING only because upstream's TriggerStrategy has
// no member for "the host fires this".
//
// `already bound?` is the ERP path: where an ERP mints the id it is already on
// the commitment and the approval carried it through, so there is no order to
// create. The demo has no ERP, which is why this workflow exists — say that
// out loud when demoing.
export function orderBindingWorkflowGraph({ umhConnectionId }) {
  const triggerId = randomUUID();
  const ledger = randomUUID();
  const bound = randomUUID();
  const runnable = randomUUID();
  const order = randomUUID();
  const bind = randomUUID();
  const failed = randomUUID();
  const notRunnable = randomUUID();
  return {
    trigger: {
      id: triggerId,
      blockType: DOCUMENT_EVENT_BLOCK,
      config: { documentType: LEDGER_TYPE, actionType: "APPROVE_ORDER" },
    },
    steps: [
      {
        id: ledger,
        key: "ledger",
        name: "Read the approved ledger",
        blockType: GET_BLOCK,
        config: {
          documentId: "{{trigger.payload.documentId}}",
          documentType: LEDGER_TYPE,
        },
        position: { x: 320, y: 0 },
      },
      {
        id: bound,
        key: "bound",
        name: "Does it already name an order?",
        blockType: "core#branch",
        // Truthiness: BIND_ORDER_ID normalises a blank id to null, so an
        // unbound ledger reads false here and takes the branch below.
        config: { condition: "{{steps.ledger.output.state.orderId}}" },
        position: { x: 640, y: 0 },
      },
      {
        id: runnable,
        key: "runnable",
        name: "Is there a line to run it on?",
        // The editor lists the line as a blocker, so a reviewer cannot
        // approve without one. This is the same rule where it is enforced
        // rather than requested: the floor accepts an empty
        // line_instance_id and makes an order nothing can run.
        blockType: "core#assert",
        config: {
          value: "{{steps.ledger.output.state.line}}",
          message:
            "No production line is set on the ledger, so there is nothing to create the order on.",
        },
        position: { x: 960, y: 0 },
      },
      {
        id: order,
        key: "order",
        name: "Create the order on the floor",
        blockType: CREATE_ORDER_BLOCK,
        connectionId: umhConnectionId,
        config: {
          line_instance_id: "{{steps.ledger.output.state.line}}",
          product_id: "{{steps.ledger.output.state.partNumber}}",
          planned_qty: "{{steps.ledger.output.state.committedQuantity}}",
        },
        position: { x: 960, y: 120 },
      },
      {
        id: bind,
        key: "bind",
        name: "Bind the id and open the ledger",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{trigger.payload.documentId}}",
          documentType: LEDGER_TYPE,
          // One batch, so a ledger is never bound-but-unopened: the two
          // together are what the editor used to do in one dispatch.
          allowedActions: "BIND_ORDER_ID,OPEN_LEDGER",
          actions: [
            {
              type: "BIND_ORDER_ID",
              input: { orderId: "{{steps.order.output.id}}" },
            },
            {
              type: "OPEN_LEDGER",
              // The floor's own timestamp: the ledger opens when the order it
              // covers came into existence, not when this step got around to
              // saying so.
              input: { openedAt: "{{steps.order.output.created_at}}" },
            },
          ],
        },
        position: { x: 1280, y: 120 },
      },
      {
        id: failed,
        key: "failed",
        name: "Say why the order was not created",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{trigger.payload.documentId}}",
          documentType: LEDGER_TYPE,
          allowedActions: "RECORD_ORDER_BINDING_FAILURE",
          actions: [
            {
              type: "RECORD_ORDER_BINDING_FAILURE",
              // Redacted by the engine before it reaches here. When it
              // happened is the operation's own timestamp, so the action does
              // not carry one — nothing in a workflow expression can produce
              // a clock reading anyway.
              input: { error: "{{steps.order.error}}" },
            },
          ],
        },
        position: { x: 1280, y: 320 },
      },
      {
        id: notRunnable,
        key: "no-line",
        name: "Say there is no line to run it on",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{trigger.payload.documentId}}",
          documentType: LEDGER_TYPE,
          allowedActions: "RECORD_ORDER_BINDING_FAILURE",
          actions: [
            {
              type: "RECORD_ORDER_BINDING_FAILURE",
              input: { error: "{{steps.runnable.error}}" },
            },
          ],
        },
        position: { x: 1280, y: -160 },
      },
    ],
    edges: [
      { id: randomUUID(), from: triggerId, to: ledger, port: "next" },
      { id: randomUUID(), from: ledger, to: bound, port: "next" },
      { id: randomUUID(), from: bound, to: runnable, port: "false" },
      { id: randomUUID(), from: runnable, to: order, port: "next" },
      { id: randomUUID(), from: runnable, to: notRunnable, port: "error" },
      { id: randomUUID(), from: order, to: bind, port: "next" },
      { id: randomUUID(), from: order, to: failed, port: "error" },
    ],
  };
}
