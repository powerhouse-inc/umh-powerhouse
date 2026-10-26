// Purchase orders by email: points Paperless's own mail fetcher at a Gmail
// label, or switches it off again. Paperless keeps mail accounts in its
// database and reads none from its environment, so this script is what turns
// the settings in .env into a mail account and a mail rule.
//
//   docker compose run --rm mail-setup   # start.sh runs it on every start
//
// On (PAPERLESS_MAIL_ENABLED=true): Paperless checks the label for new mail and
// imports its PDF attachments as Purchase Orders — the same document a PDF
// dropped into .local/consume/ becomes, so the same workflow drafts a ledger.
// Off: the rule is disabled and Paperless stops logging in to the mailbox.
// Dropping and uploading PDFs work either way.
//
// Idempotent: it looks before it writes, so re-running it after editing .env
// is how a change is applied.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env, for a run outside compose. A variable already in the environment wins.
function loadEnvFile() {
  const file = path.join(repoRoot, ".env");
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

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;

const PAPERLESS_URL = env("PAPERLESS_URL", "http://localhost:8000").replace(/\/+$/, "");
const PAPERLESS_USER = env("PAPERLESS_USER", "admin");
const PAPERLESS_PASSWORD = env("PAPERLESS_PASSWORD", "paperless");

const ENABLED = /^(1|true|yes|on)$/i.test(env("PAPERLESS_MAIL_ENABLED"));
const ADDRESS = env("PAPERLESS_MAIL_ADDRESS");
// Google shows an app password as four groups of four; IMAP wants it whole.
const APP_PASSWORD = env("PAPERLESS_MAIL_APP_PASSWORD").replace(/\s+/g, "");
const IMAP_SERVER = env("PAPERLESS_MAIL_IMAP_SERVER", "imap.gmail.com");
const IMAP_PORT = Number(env("PAPERLESS_MAIL_IMAP_PORT", "993"));
const FOLDER = env("PAPERLESS_MAIL_FOLDER", "paperless");
const DONE_LABEL = env("PAPERLESS_MAIL_DONE_LABEL", "paperless-imported");
const FILTER_FROM = env("PAPERLESS_MAIL_FROM") || null;
const FILTER_SUBJECT = env("PAPERLESS_MAIL_SUBJECT") || null;
const MAX_AGE_DAYS = Number(env("PAPERLESS_MAIL_MAX_AGE_DAYS", "7"));
const CHECK_CRON = env("PAPERLESS_MAIL_CHECK_CRON", "* * * * *");

const RULE_NAME = "Purchase orders by email";
const DOCTYPE = "Purchase Order";

// Paperless's numeric choices, from paperless_mail/models.py in 3.0.5.
const IMAP_SECURITY = { none: 1, ssl: 2, starttls: 3 };
const ACCOUNT_TYPE_IMAP = 1;
const ACTION_TAG = 5; // label the mail, and skip mail that already has the label
const TITLE_FROM_FILENAME = 2; // a dropped file is titled by its name too
const ONLY_ATTACHMENTS = 1; // for attachment_type and consumption_scope alike

const log = (message) => console.log(message);

async function paperless(apiPath, { method = "GET", body, token } = {}) {
  const response = await fetch(`${PAPERLESS_URL}${apiPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Token ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(
      `paperless ${method} ${apiPath} -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : undefined;
}

async function login(seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const body = await paperless("/api/token/", {
        method: "POST",
        body: { username: PAPERLESS_USER, password: PAPERLESS_PASSWORD },
      });
      return body.token;
    } catch (error) {
      // A login Paperless rejects will not start working; only a stack that is
      // still starting is worth waiting for.
      if ([400, 401, 403].includes(error.status)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`No Paperless at ${PAPERLESS_URL} after ${seconds}s (${error.message})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

const list = async (apiPath, token) =>
  (await paperless(`${apiPath}?page_size=1000`, { token })).results ?? [];

function imapSecurity() {
  const named = env("PAPERLESS_MAIL_IMAP_SECURITY").toLowerCase();
  if (named) {
    if (!(named in IMAP_SECURITY)) {
      throw new Error(`PAPERLESS_MAIL_IMAP_SECURITY must be ssl, starttls or none, not "${named}"`);
    }
    return IMAP_SECURITY[named];
  }
  return IMAP_PORT === 993 ? IMAP_SECURITY.ssl : IMAP_SECURITY.starttls;
}

async function switchOff(token, rule) {
  if (rule?.enabled) {
    await paperless(`/api/mail_rules/${rule.id}/`, { method: "PATCH", body: { enabled: false }, token });
    log(`email intake: off — disabled the rule "${RULE_NAME}", Paperless stops checking the mailbox`);
  } else {
    log("email intake: off (set PAPERLESS_MAIL_ENABLED=true in .env to turn it on)");
  }
}

async function switchOn(token, rules) {
  if (!ADDRESS || !APP_PASSWORD) {
    throw new Error(
      "PAPERLESS_MAIL_ENABLED is true, but PAPERLESS_MAIL_ADDRESS or PAPERLESS_MAIL_APP_PASSWORD is empty in .env",
    );
  }
  if (!Number.isInteger(MAX_AGE_DAYS) || MAX_AGE_DAYS < 1) {
    throw new Error(`PAPERLESS_MAIL_MAX_AGE_DAYS must be a whole number of days, not "${env("PAPERLESS_MAIL_MAX_AGE_DAYS")}"`);
  }

  const connection = {
    imap_server: IMAP_SERVER,
    imap_port: IMAP_PORT,
    imap_security: imapSecurity(),
    username: ADDRESS,
    password: APP_PASSWORD,
    account_type: ACCOUNT_TYPE_IMAP,
  };

  // Log in once now, so a wrong password fails here with a reason instead of
  // every minute in Paperless's mail log.
  try {
    await paperless("/api/mail_accounts/test/", { method: "POST", body: connection, token });
  } catch (error) {
    if (error.status !== 400) throw error;
    throw new Error(
      `${IMAP_SERVER}:${IMAP_PORT} refused the login for ${ADDRESS}, or could not be reached. ` +
        "PAPERLESS_MAIL_APP_PASSWORD must be a Google app password, not the account's normal password — see the README.",
    );
  }

  // The account for this address, if there is one — including one added by
  // hand in the Paperless UI. A second account would log in to the same
  // mailbox and import every PDF twice.
  const accounts = await list("/api/mail_accounts/", token);
  const existing = accounts.find(
    (account) =>
      account.imap_server?.toLowerCase() === IMAP_SERVER.toLowerCase() &&
      account.username?.toLowerCase() === ADDRESS.toLowerCase(),
  );
  const account = existing
    ? await paperless(`/api/mail_accounts/${existing.id}/`, { method: "PATCH", body: connection, token })
    : await paperless("/api/mail_accounts/", { method: "POST", body: { name: ADDRESS, ...connection }, token });
  log(`email intake: ${existing ? "updated" : "created"} the mail account "${account.name}"`);

  // The seed creates the type. Every PDF in the label becomes a Purchase Order,
  // so a PO that never says "order" (a German "Bestellung") still gets a ledger.
  const types = await paperless(
    `/api/document_types/?name__iexact=${encodeURIComponent(DOCTYPE)}`,
    { token },
  );
  const documentTypeId = types.results?.[0]?.id ?? null;
  if (documentTypeId === null) {
    log(`email intake: no "${DOCTYPE}" document type yet (the seed creates it); Paperless will classify by the word "order"`);
  }

  const ruleBody = {
    name: RULE_NAME,
    account: account.id,
    enabled: true,
    folder: FOLDER,
    filter_from: FILTER_FROM,
    filter_subject: FILTER_SUBJECT,
    filter_attachment_filename_include: "*.pdf",
    maximum_age: MAX_AGE_DAYS,
    action: ACTION_TAG,
    action_parameter: DONE_LABEL,
    assign_title_from: TITLE_FROM_FILENAME,
    assign_document_type: documentTypeId,
    attachment_type: ONLY_ATTACHMENTS,
    consumption_scope: ONLY_ATTACHMENTS,
  };
  const rule = rules.find((candidate) => candidate.name === RULE_NAME);
  if (rule) {
    await paperless(`/api/mail_rules/${rule.id}/`, { method: "PATCH", body: ruleBody, token });
  } else {
    await paperless("/api/mail_rules/", { method: "POST", body: ruleBody, token });
  }
  log(`email intake: ${rule ? "updated" : "created"} the mail rule "${RULE_NAME}"`);

  const others = rules.filter(
    (candidate) => candidate.account === account.id && candidate.enabled && candidate.name !== RULE_NAME,
  );
  if (others.length) {
    log(
      `email intake: this account also has the enabled rule(s) ${others.map((r) => `"${r.name}"`).join(", ")}. ` +
        "They import too — disable them under Mail in Paperless if they cover the same mail.",
    );
  }

  // Check once now rather than waiting for the first scheduled run.
  await paperless(`/api/mail_accounts/${account.id}/process/`, { method: "POST", token });
  log(
    `email intake: on — Paperless imports PDFs from new mail labelled "${FOLDER}" in ${ADDRESS} ` +
      `(schedule "${CHECK_CRON}", mail up to ${MAX_AGE_DAYS} days old) and labels each one "${DONE_LABEL}"`,
  );
}

async function main() {
  const token = await login();
  const rules = await list("/api/mail_rules/", token);
  if (ENABLED) {
    await switchOn(token, rules);
  } else {
    await switchOff(token, rules.find((rule) => rule.name === RULE_NAME));
  }
}

main().catch((error) => {
  console.error(`email intake: ${error.message}`);
  process.exit(1);
});
