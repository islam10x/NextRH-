# n8n Workflow Setup — NextRH Notification System (Production)

This guide walks you through setting up **n8n** to send email notifications for NextRH.

## How It Works (Architecture)

```
 ┌────────────┐  instant push   ┌──────┐  SMTP   ┌──────────────┐
 │  Backend   │ ───────────────►│  n8n │ ───────►│  Mailbox     │
 │  (NestJS)  │   webhook POST  │      │         │  (user inbox)│
 └─────┬──────┘                 └──┬───┘         └──────────────┘
       │                           │
       │  marks email_sent=true ◄──┘  callback PATCH
       │
       │  07:30 AM daily fallback sweep
       │  re-pushes any email_sent=false
       └──────────────────────────────────────────►  n8n (same webhook)
```

**Real-time push**: Every time the backend creates a notification (cert expiry,
training assigned, etc.) it immediately fires a POST to n8n. n8n sends the email,
then calls the backend back to set `email_sent = true`.

**Daily fallback sweep** (07:30 AM): A cron job finds any notifications that are
still `email_sent = false` (n8n was down, network blip, etc.) and re-pushes them.
This guarantees **zero lost emails** with **near-instant delivery**.

---

## Table of Contents

1. [Step 1 — Add n8n to Docker Compose](#step-1--add-n8n-to-docker-compose)
2. [Step 2 — Start n8n](#step-2--start-n8n)
3. [Step 3 — First-Time n8n Setup](#step-3--first-time-n8n-setup)
4. [Step 4 — Create SMTP Credentials](#step-4--create-smtp-credentials)
5. [Step 5 — Build the Workflow](#step-5--build-the-workflow)
6. [Step 6 — Activate the Workflow](#step-6--activate-the-workflow)
7. [Step 7 — Test End-to-End](#step-7--test-end-to-end)
8. [Environment Variables Reference](#environment-variables-reference)
9. [Troubleshooting](#troubleshooting)

---

## Step 1 — Add n8n to Docker Compose

This is **already done** in `docker-compose.yml`. The relevant service block is:

```yaml
  n8n:
    image: n8nio/n8n:latest
    container_name: cv-n8n
    restart: unless-stopped
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - WEBHOOK_URL=http://localhost:5678/
      - GENERIC_TIMEZONE=Europe/Paris
    volumes:
      - n8n-data:/home/node/.n8n
    ports:
      - "5678:5678"
    networks:
      - cv-network
    # backend is local (not a container), so no depends_on
```

The backend also has these environment variables injected (in the `backend` service
block of `docker-compose.yml`):

```yaml
      N8N_WEBHOOK_URL: 
      N8N_WEBHOOK_SECRET: 
```

For local development (backend running outside Docker), the `.env` file has:

```dotenv
N8N_WEBHOOK_URL=
N8N_WEBHOOK_SECRET=
```

---

## Step 2 — Start n8n

```bash
docker compose up -d n8n
```

Wait ~20 seconds, then verify:

```bash
docker logs cv-n8n --tail 10
```

You should see `n8n ready on 0.0.0.0, port 5678`.

---

## Step 3 — First-Time n8n Setup

1. Open **http://localhost:5678** in your browser.
2. n8n will ask you to create an **owner account**. Fill in:
   - **Email**: your admin email (e.g. `admin@nextrh.com`)
   - **First name**: Admin
   - **Last name**: NextRH
   - **Password**: choose a strong password
3. Click **Next**.
4. Skip any survey/onboarding prompts by clicking **Skip** or **Get started**.
5. You'll land on the **Workflows** page (empty).

---

## Step 4 — Create SMTP Credentials

1. In the left sidebar, click **Credentials** (key icon).
2. Click **Add Credential** (top-right).
3. Search for **"SMTP"** and select it.
4. Fill in the fields:

   | Field               | Mailtrap (dev)                     | Production (your company SMTP)  |
   |---------------------|------------------------------------|---------------------------------|
   | **Credential Name** | `NextRH SMTP`                      | `NextRH SMTP`                   |
   | **Host**            | `sandbox.smtp.mailtrap.io`         | e.g. `smtp.office365.com`      |
   | **Port**            | `2525`                             | `587`                          |
   | **User**            | Your Mailtrap username             | SMTP username                  |
   | **Password**        | Your Mailtrap password             | SMTP password / app password   |
   | **SSL/TLS**         | Leave unchecked                    | Check **STARTTLS**             |

   > **Tip**: Use the exact same values as `MAIL_HOST`, `MAIL_USER`,
   > `MAIL_PASSWORD`, `MAIL_PORT` from `backend/.env`.

5. Click **Save**. You should see **"Connection tested successfully"**.

---

## Step 5 — Build the Workflow

### 5.1 — Create a New Workflow

1. Click the **n8n logo** (top-left) → **Workflows** → **Add Workflow**.
2. Click the title at the top and rename it to: **NextRH – Send Notification Emails**

### 5.2 — Node 1: Webhook (Trigger)

This is the trigger that receives instant pushes from the backend.

1. Click the **"Add first step…"** button on the canvas.
2. Search for **"Webhook"** and click it.
3. Configure:
   - **HTTP Method**: `POST`
   - **Path**: `nextrh-notification`
4. You'll see the generated URL at the top:
   - **Production URL**: `http://localhost:5678/webhook/nextrh-notification`
   - This is what the backend posts to.
   - **Important**: Do NOT use `/webhook-test/` for production runs.
5. Under **Authentication** → Select **Header Auth**.
6. Click **Create New Credential** and fill in:
   - **Credential Name**: `NextRH Webhook Auth`
   - **Name**: `x-webhook-secret`
   - **Value**: `nextrh-n8n-secret`
7. Click **Save** on the credential, then click **Back to canvas**.

### 5.3 — Node 2: IF (Guard — has email?)

Prevents errors when user email is missing.

1. Click the **+** on the right side of the Webhook node.
2. Search for **"IF"** and click it.
3. Configure the condition (String check):
   - **Type**: **String**
   - **Value 1**: Click the **expression** tab (⚡) → type: `{{ $json.body.userEmail }}`
   - **Operation**: `is not empty`
4. Rename this node to: **Has Email?** (click the title).
5. Click **Back to canvas**.

### 5.4 — Node 3: Send Email (on the TRUE branch)

1. Click the **+** on the **true** (green ✓) output of the IF node.
2. Search for **"Send Email"** and click it.
3. Configure:
   - **Credential to connect with**: Select **NextRH SMTP** (from Step 4).
   - **From Email**: `notifications@nextrh.com`
     > Use the same as `MAIL_FROM_ADDRESS` in your backend `.env`.
   - **To Email**: Click ⚡ expression → `{{ $json.body.userEmail }}`
   - **Subject**: Click ⚡ expression → `{{ $json.body.title }}`
   - **Email Format**: Select **HTML**
   - **HTML Body**: Click ⚡ expression and paste:
     ```html
     <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
       <h2 style="color: #3b82f6;">{{ $json.body.title }}</h2>
       <p>Hello {{ $json.body.userName || 'there' }},</p>
       <p style="font-size: 15px; line-height: 1.6;">{{ $json.body.message }}</p>
       <div style="text-align: center; margin: 28px 0;">
         <a href="http://localhost:5173/login"
            style="background-color: #3b82f6; color: white; padding: 12px 28px;
                   text-decoration: none; border-radius: 6px; font-weight: 600;">
           Open NextRH
         </a>
       </div>
       <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
       <p style="font-size: 0.8em; color: #999;">
         This is an automated notification from NextRH.
       </p>
     </div>
     ```
     > **Production**: Replace `http://localhost:5173` with your actual frontend URL.
4. Rename this node to: **Send Notification Email**.
5. Click **Back to canvas**.

### 5.5 — Node 4: HTTP Request (Mark Email Sent — callback to backend)

After successfully sending the email, tell the backend so it doesn't re-send.

1. Click the **+** on the right of the **Send Notification Email** node.
2. Search for **"HTTP Request"** and click it.
3. Configure:
   - **Method**: `PATCH`
   - **URL**: Click ⚡ expression → type:
     ```
     http://host.docker.internal:3000/webhooks/notifications/{{ $node["Webhook"].json.body.notificationId }}/email-sent
     ```
     > This targets the backend running on your host (n8n is in Docker).
     > If you run n8n outside Docker, use `http://localhost:3000/...` instead.
   - Under **Send Headers** → toggle **ON** → Click **Add Header**:
     - **Header Name**: `x-webhook-secret`
     - **Header Value**: `nextrh-n8n-secret`
4. Rename this node to: **Mark Email Sent**.
5. Click **Back to canvas**.

### Final Workflow Layout

```
[Webhook: nextrh-notification]
        │
        ▼
  [Has Email?]
     ├── true ──► [Send Notification Email] ──► [Mark Email Sent]
     └── false ─► (end)
```

---

## Step 6 — Activate the Workflow

1. Click **Publish** (top-right).
2. Confirm: green dot + **Published**.

> **Important**: The Webhook node URL only works in production mode when the
> workflow is **published**. Test URLs (shown while editing) are different from the
> production URL. Do not click **Execute workflow** for production tests.

---

## Step 7 — Test End-to-End

### 7.1 — Create a Test Notification via the Webhook API

Run in PowerShell (find a real user UUID first):

```powershell
# Find a user UUID
docker exec -i cv-postgres psql -U postgres -d cv_management -c "SELECT user_id, email FROM users LIMIT 5;"

# Create a notification (replace <USER_UUID>)
Invoke-RestMethod -Uri http://localhost:3000/webhooks/notifications `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-webhook-secret" = "nextrh-n8n-secret" } `
  -Body '{"userId":"<USER_UUID>","type":"certification_expiring","title":"Test: AWS cert expires in 20 days","message":"Your AWS Solutions Architect certification expires on April 1, 2026. Please renew it."}'
```

This creates the in-app notification **and** the backend instantly pushes the
payload to n8n → n8n sends the email → n8n calls back to mark it sent.

### 7.2 — Verify in n8n

1. Go to the n8n UI → Your workflow → Click **Executions** (left sidebar, clock icon).
2. You should see a new execution. Click it to see the data flowing through each node.

### 7.3 — Verify in Database

```powershell
docker exec -i cv-postgres psql -U postgres -d cv_management `
  -c "SELECT notification_id, title, email_sent, created_at FROM notifications ORDER BY created_at DESC LIMIT 5;"
```

The test notification should show `email_sent = true`.

### 7.4 — Verify the Fallback Sweep

To manually trigger the daily fallback sweep (without waiting until 7:30 AM):

```powershell
# Set a notification to email_sent=false to simulate a missed push
docker exec -i cv-postgres psql -U postgres -d cv_management `
  -c "UPDATE notifications SET email_sent = false WHERE notification_id = '<NOTIFICATION_ID>';"
```

Then wait for the 7:30 AM cron, or restart the backend to test immediately by
verifying logs: `Backend log: "Running daily email-fallback sweep…"`

---

## Environment Variables Reference

| Variable | Where | Default | Description |
|----------|-------|---------|-------------|
| `N8N_WEBHOOK_SECRET` | `backend/.env` + `docker-compose.yml` | `nextrh-n8n-secret` | Shared secret between backend ↔ n8n |
| `N8N_WEBHOOK_URL` | `backend/.env` (local) / `docker-compose.yml` (Docker) | `http://localhost:5678/webhook/nextrh-notification` | URL the backend pushes notifications to |
| `MAIL_HOST` | `backend/.env` | – | SMTP server host (same credentials used in n8n) |
| `MAIL_PORT` | `backend/.env` | `2525` | SMTP port |
| `MAIL_USER` | `backend/.env` | – | SMTP username |
| `MAIL_PASSWORD` | `backend/.env` | – | SMTP password |
| `MAIL_FROM_ADDRESS` | `backend/.env` | – | Sender email address |

**Production checklist:**
- [ ] Change `N8N_WEBHOOK_SECRET` to a strong random string (e.g. `openssl rand -hex 32`).
- [ ] Set `MAIL_*` to your real SMTP provider (Office 365, Gmail SMTP, SendGrid, etc.).
- [ ] Replace `http://localhost:5173` in the email template with your production frontend URL.
- [ ] Consider putting n8n behind a reverse proxy with HTTPS for the UI.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| n8n shows no executions | Check the workflow is **Published** (green dot). Test URLs only work in the editor. |
| Backend log: `n8n push failed` | Verify n8n is running (`docker ps \| findstr n8n`). Check the container name resolves (`cv-n8n`). |
| Email not received | Open the failed execution in n8n → click the Send Email node → check the error. Usually wrong SMTP credentials. |
| `Invalid webhook secret` on n8n | Ensure the Header Auth credential in n8n has name = `x-webhook-secret` and value = `nextrh-n8n-secret` (must match backend). |
| Duplicate emails sent | The `email_sent` flag prevents re-sends. If you see duplicates, check the **Mark Email Sent** node is connected and working. |
| n8n can't reach backend | If backend is local, use `http://host.docker.internal:3000/...` in the HTTP Request node. If both are containers, use the service name. |
| Executions show only Webhook + IF nodes | Use `{{ $json.body.userEmail }}` with **String / is not empty** in the IF node. |
| Mark Email Sent returns 404 | Ensure URL uses `{{ $node["Webhook"].json.body.notificationId }}` and no line breaks in the URL field. |
| Fallback sweep sends old notifications | The sweep only sends notifications where `email_sent = false`. Old notifications that were already emailed won't be re-sent. |

---

## API Endpoints Used by n8n

| Method | URL | Auth Header | Purpose |
|--------|-----|-------------|---------|
| `PATCH` | `/webhooks/notifications/:id/email-sent` | `x-webhook-secret` | Mark notification as emailed (callback) |
| `GET` | `/webhooks/notifications/pending-emails` | `x-webhook-secret` | List un-emailed notifications (fallback) |
| `POST` | `/webhooks/notifications` | `x-webhook-secret` | Create a notification (optional, external use) |
| `GET` | `/webhooks/health` | *(none)* | Health check |

---

## How the Backend Cron Jobs Work

| Cron | Schedule | What it does |
|------|----------|--------------|
| **Certification expiry check** | Daily at 7:00 AM | Scans all certifications. If one expires within 30 days and hasn't been alerted yet, creates an alert + notification. The notification is instantly pushed to n8n for email. |
| **Email fallback sweep** | Daily at 7:30 AM | Finds all notifications with `email_sent = false` and re-pushes them to n8n. Catches any that were missed due to n8n downtime. |

No polling. No 5-minute schedules. Emails go out **instantly** when events happen.

