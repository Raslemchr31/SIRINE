# INSTALL — SIRINE bot on a Linux VPS

Time needed: ~15 minutes. You need a VPS (2 vCPU / 4 GB RAM minimum), a domain name,
a Google Gemini API key, and a Meta (Facebook) developer app.

## 1. Prerequisites on the VPS

```bash
# Docker + Compose (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
# make + git + openssl (usually already present)
sudo apt-get install -y make git openssl curl
```

Point a DNS **A record** at your VPS, e.g. `chat.yourdomain.com → <VPS IP>`.
Open ports **80** and **443** in your firewall (and **8055** if the team will use the
catalog UI remotely — or keep it closed and use an SSH tunnel).

## 2. Get the code and configure

```bash
git clone https://github.com/Raslemchr31/SIRINE.git
cd SIRINE
cp .env.example .env
nano .env        # fill ONLY the CLIENT section:
```

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — use a key with billing enabled (the free tier stops after ~20 messages/day) |
| `FB_APP_ID` + `FB_APP_SECRET` | [developers.facebook.com](https://developers.facebook.com) → your app → Settings → Basic |
| `FRONTEND_URL` | `https://chat.yourdomain.com` (the domain from step 1) |
| `DIRECTUS_ADMIN_EMAIL` / `CHATWOOT_ADMIN_EMAIL` | the email your team will log in with |

Leave everything else empty — the installer generates it.

## 3. Run the installer

```bash
make setup
```

This single command (safe to re-run any time): generates all secrets, starts the stack,
prepares the Chatwoot database, fixes the Messenger send flag, creates your admin logins,
seeds the SIRINE catalog, creates the bot, and prints your **Meta webhook URL + verify token**.

## 4. Connect Facebook (one-time, in the browser)

1. **Meta app webhook** — developers.facebook.com → your app → **Messenger → Settings → Webhooks**:
   - Callback URL: `https://chat.yourdomain.com/meta/webhook`
   - Verify token: printed at the end of `make setup` (also in `.env` as `FB_VERIFY_TOKEN`)
   - Webhook fields: subscribe to `messages`, `messaging_postbacks`, `messaging_referrals`
2. **Connect the page** — open `https://chat.yourdomain.com`, log in with your Chatwoot
   admin, then **Inboxes → New Inbox → Messenger** and authorize your Facebook page.
3. **Wire the bot to the new inbox**:
   ```bash
   make wire-bot
   ```
4. Send *"salam"* to your Facebook page from another account — the bot answers in Darija.

> App review: to talk to the general public your Meta app needs `pages_messaging`
> approved (App Review). While the app is in Development mode, only app
> admins/developers/testers can message the page — use that for testing.

## 5. Done — daily usage

Everything the team needs (adding products, viewing orders, handoffs, logs) is in
**[RUNBOOK.md](./RUNBOOK.md)**.

## Troubleshooting install

| Symptom | Fix |
|---|---|
| `make setup` says a CLIENT variable is empty | Fill it in `.env`, run `make setup` again |
| Chatwoot page won't load right after install | First Rails boot is slow — wait ~1 min, retry |
| Bot doesn't reply on Facebook | Did you run `make wire-bot` after connecting the page? Is the webhook verified in the Meta app? Check `docker compose logs agent-handler` |
| Messenger replies fail with error #100/1893061 | The HUMAN_AGENT flag is missing — `make setup` sets it; re-run it |
| Want a tunnel instead of a domain (testing) | Set `FRONTEND_URL` to your tunnel URL (ngrok/cloudflared); the edge proxy is skipped automatically — point the tunnel at port 3037, and the Meta callback at `<tunnel>/meta/webhook` only works if the tunnel reaches agent-handler (use the domain mode for production) |
