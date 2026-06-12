// chatwoot/setup.mjs — idempotent Chatwoot provisioning for SIRINE.
// Creates (if absent) an API-channel inbox + an AgentBot, attaches the bot to the inbox,
// and prints the identifiers Phase 4 (the agent handler) needs. Zero deps — uses fetch.
//
// Run AFTER you've created the admin in the UI and pasted its token into .env:
//   node --env-file=.env chatwoot/setup.mjs
//
// Env (from .env): CHATWOOT_API_ACCESS_TOKEN (required), CHATWOOT_ACCOUNT_ID (default 1),
//   CHATWOOT_URL (default http://localhost:3000), AGENT_WEBHOOK_URL (placeholder until Phase 4).

const BASE = process.env.CHATWOOT_URL || "http://localhost:3037";
const ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID || "1";
const TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN;
// Placeholder webhook — the real agent handler lands in Phase 4; re-run setup then to update.
const AGENT_WEBHOOK = process.env.AGENT_WEBHOOK_URL || "http://host.docker.internal:8082/agentbot";

const INBOX_NAME = "SIRINE Bot Inbox";
const BOT_NAME = "SIRINE Brain";

if (!TOKEN) {
  console.error("ERROR: CHATWOOT_API_ACCESS_TOKEN is empty. Create the admin in the UI, copy its");
  console.error("Access Token (Profile Settings → Access Token) into .env, then re-run with:");
  console.error("  node --env-file=.env chatwoot/setup.mjs");
  process.exit(1);
}

const api = `${BASE}/api/v1/accounts/${ACCOUNT}`;
const H = { api_access_token: TOKEN, "Content-Type": "application/json" };

async function req(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}
const list = (j) => (Array.isArray(j) ? j : j.payload || j.data || []);

async function main() {
  console.log(`Chatwoot setup → ${BASE} (account ${ACCOUNT})`);

  // 1. API-channel inbox (idempotent by name)
  const inboxes = list(await req("GET", "/inboxes"));
  let inbox = inboxes.find((i) => i.name === INBOX_NAME);
  if (inbox) {
    console.log(`  inbox "${INBOX_NAME}": exists (id ${inbox.id})`);
  } else {
    inbox = await req("POST", "/inboxes", {
      name: INBOX_NAME,
      channel: { type: "api", webhook_url: AGENT_WEBHOOK },
    });
    console.log(`  inbox "${INBOX_NAME}": created (id ${inbox.id})`);
  }
  // inbox_identifier may not be echoed on create — fetch the inbox to be sure.
  const inboxFull = await req("GET", `/inboxes/${inbox.id}`);
  const inboxIdentifier = inboxFull.inbox_identifier || inbox.inbox_identifier || "(read from UI → Inbox → Configuration)";

  // 2. AgentBot (idempotent by name)
  const bots = list(await req("GET", "/agent_bots"));
  let bot = bots.find((b) => b.name === BOT_NAME);
  if (bot) {
    console.log(`  agent bot "${BOT_NAME}": exists (id ${bot.id})`);
    // Repoint an existing bot's outgoing_url (create-only set is not enough once
    // the Phase 4 handler exists — the bot keeps its stale placeholder URL).
    if (bot.outgoing_url !== AGENT_WEBHOOK) {
      await req("PATCH", `/agent_bots/${bot.id}`, { outgoing_url: AGENT_WEBHOOK });
      console.log(`  repointed bot ${bot.id} outgoing_url → ${AGENT_WEBHOOK}`);
    } else {
      console.log(`  outgoing_url already → ${AGENT_WEBHOOK}`);
    }
  } else {
    bot = await req("POST", "/agent_bots", {
      name: BOT_NAME,
      description: "SIRINE catalog-grounded AI brain (handler arrives Phase 4)",
      outgoing_url: AGENT_WEBHOOK,
      bot_type: 0,
    });
    console.log(`  agent bot "${BOT_NAME}": created (id ${bot.id})`);
  }

  // 3. Attach the bot to EVERY inbox (idempotent). This is what makes `make wire-bot`
  // re-runnable after the team connects the real Facebook page in the Chatwoot UI:
  // the new Messenger inbox gets the bot automatically on the next run.
  const allInboxes = list(await req("GET", "/inboxes"));
  for (const ib of allInboxes) {
    await req("POST", `/inboxes/${ib.id}/set_agent_bot`, { agent_bot: bot.id });
    console.log(`  attached bot ${bot.id} → inbox ${ib.id} (${ib.name})`);
  }

  console.log("\n── Save these (Phase 4 needs them) ──");
  console.log(`CHATWOOT_INBOX_ID=${inbox.id}`);
  console.log(`CHATWOOT_INBOX_IDENTIFIER=${inboxIdentifier}`);
  console.log(`CHATWOOT_AGENT_BOT_ID=${bot.id}`);
  console.log(`CHATWOOT_AGENT_BOT_TOKEN=${bot.access_token || "(existing bot — get via UI or recreate)"}`);
  console.log(`\noutgoing_url → ${AGENT_WEBHOOK} (set AGENT_WEBHOOK_URL to change).`);
  console.log("seed: chatwoot provisioned ✓");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("chatwoot setup FAILED —", err.message);
  process.exit(1);
});
