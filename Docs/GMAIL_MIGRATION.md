
What you need to do (in order)
Enable 2-Step Verification on the Gmail account: https://myaccount.google.com/security
Generate an App Password (Gmail rejects regular passwords for SMTP): https://myaccount.google.com/apppasswords → Strip the spaces from the 16-char value.
Edit backend/.env — fill in MAIL_USER, MAIL_FROM_ADDRESS, MAIL_PASSWORD with the real Gmail address and App Password.
Restart the backend (npm run start:dev or docker compose restart backend).
Update n8n — the SMTP credential lives inside n8n itself, not in code. See the guide below.
# Migrating Email Delivery from Mailtrap to Gmail

This guide covers everything required to switch all NextRH email delivery
(invitations, **password reset**, training assignments, team-added notices, and
n8n notification emails) from Mailtrap to Gmail SMTP.

---

## 1. Background — How Email Is Sent in NextRH

NextRH has **two** independent email senders that must both be reconfigured:

| Sender | Code path | Used for |
|---|---|---|
| **Backend (NestJS)** — direct SMTP via `nodemailer` | [backend/src/mail/mail.service.ts](../backend/src/mail/mail.service.ts) | Invitations, **Forgot Password / Reset Password**, "training assigned", "team added" |
| **n8n workflow** — SMTP credential inside n8n | n8n UI (workflow: *NextRH – Send Notification Emails*) | All in-app notifications pushed via the webhook (cert-expiry, etc.) |

Both must point at Gmail SMTP for the migration to be complete. Forgetting the
n8n side will silently break notification emails even though "Forgot Password"
still works (and vice-versa).

---

## 2. One-Time Gmail Setup (Required)

Gmail blocks plain login for SMTP. You **must** use an *App Password*.

### 2.1 — Enable 2-Step Verification

1. Go to https://myaccount.google.com/security
2. Turn on **2-Step Verification** (required to generate App Passwords).

### 2.2 — Create an App Password

1. Go to https://myaccount.google.com/apppasswords
2. **App name**: `NextRH SMTP` (any descriptive label)
3. Click **Create**.
4. Google shows a 16-character password like `abcd efgh ijkl mnop`.
   - Copy it now — you cannot view it again later.
   - **Strip the spaces** when pasting into config (`abcdefghijklmnop`).
5. Keep this value secret. Treat it like a password (it grants full SMTP send
   access to your Gmail account).

### 2.3 — Gmail Sending Limits (Important)

Gmail enforces hard limits that Mailtrap did not:

| Plan | Daily limit (recipients/day) |
|---|---|
| Personal `@gmail.com` | ~500/day |
| Google Workspace | ~2,000/day |

If NextRH grows past these limits, switch to a transactional provider
(SendGrid, Mailgun, Amazon SES). The code will not need to change — only the
SMTP host/credentials.

---

## 3. Backend Configuration (`backend/.env`)

The backend code is already provider-agnostic — it reads SMTP settings from
env vars. The only change is the values.

The file [backend/.env](../backend/.env) has been updated to:

```dotenv
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=your.company@gmail.com
MAIL_PASSWORD=your-16-char-app-password
MAIL_FROM_NAME=CV Manager
MAIL_FROM_ADDRESS=your.company@gmail.com
MAIL_TLS_REJECT_UNAUTHORIZED=true
```

### What you must do

1. Open [backend/.env](../backend/.env).
2. Replace `your.company@gmail.com` (in **both** `MAIL_USER` and
   `MAIL_FROM_ADDRESS`) with the Gmail address you'll send from.
3. Replace `your-16-char-app-password` in `MAIL_PASSWORD` with the App Password
   from step 2.2 (no spaces).
4. **Restart the backend** so the new values are picked up:
   ```powershell
   # If running outside Docker:
   #   stop the npm process, then:
   cd backend
   npm run start:dev

   # If running inside Docker:
   docker compose restart backend
   ```

### Field reference

| Field | Value | Why |
|---|---|---|
| `MAIL_HOST` | `smtp.gmail.com` | Gmail's SMTP submission server |
| `MAIL_PORT` | `587` | STARTTLS submission port (preferred). Use `465` only if you also flip `MAIL_SECURE=true`. |
| `MAIL_SECURE` | `false` | STARTTLS upgrades the connection after handshake — `secure=true` is for implicit TLS on port 465 only. |
| `MAIL_USER` | full Gmail address | Gmail requires the full address as the SMTP username. |
| `MAIL_PASSWORD` | App Password (16 chars, no spaces) | Regular account password is rejected by Gmail. |
| `MAIL_FROM_ADDRESS` | full Gmail address | Gmail will rewrite the `From:` header to the authenticated user anyway, so keep these matching to avoid SPF/DMARC surprises. |
| `MAIL_TLS_REJECT_UNAUTHORIZED` | `true` | Gmail has valid certs; reject any MITM. (Mailtrap sandbox needed `false`; Gmail does not.) |

### Why `From:` must equal `MAIL_USER`

Gmail rewrites the visible `From:` to the authenticated account no matter what
you set. Setting `MAIL_FROM_ADDRESS` to a different address (e.g.
`next_step@nextrh.com`) will either be silently overridden or trigger
SPF/DMARC failures at the recipient. Keep them identical.

If you need a custom display address later, configure
*Settings → Accounts and Import → Send mail as* in Gmail, verify the alias,
then set `MAIL_FROM_ADDRESS` to the verified alias.

### Verifying the backend works

After restart, trigger a "Forgot Password" from the frontend with your own
email. You should:

- Receive the reset email in your Gmail inbox within seconds.
- See `Password reset email sent to <you>` in the backend logs.

If it fails, check the backend logs for the nodemailer error and consult the
[Troubleshooting](#5-troubleshooting) section below.

---

## 4. n8n Configuration (UI — no code change)

n8n stores its SMTP credential **separately** from the backend. The notification
workflow still uses the old Mailtrap credential until you update it.

### 4.1 — Update the SMTP Credential

1. Open n8n at **http://localhost:5678**.
2. Left sidebar → **Credentials** (key icon).
3. Find the credential named **`NextRH SMTP`** (created in
   [N8N_WORKFLOW_SETUP.md](N8N_WORKFLOW_SETUP.md) Step 4) and click it.
4. Replace **all** fields with Gmail values:

   | Field | Value |
   |---|---|
   | **Credential Name** | `NextRH SMTP` (leave as-is) |
   | **User** | `your.company@gmail.com` (full Gmail address) |
   | **Password** | the 16-char App Password from step 2.2 (no spaces) |
   | **Host** | `smtp.gmail.com` |
   | **Port** | `587` |
   | **SSL/TLS** | **Unchecked** (n8n will auto-use STARTTLS on 587) |
   | **Client Host Name** | leave blank |
   | **Disable STARTTLS** | **Unchecked** |

5. Click **Save**.
6. Click **Test** (or save and re-open) — n8n should report
   *"Connection tested successfully"*.

### 4.2 — Update the "From" Address in the Send Email Node

The workflow's **Send Notification Email** node hard-codes its `From` field. If
the value there does not match your Gmail address, Gmail will rewrite it (or
the mail will be rejected with `553 From address must equal authenticated user`).

1. Open the workflow **NextRH – Send Notification Emails**.
2. Click the **Send Notification Email** node.
3. Change **From Email** to your Gmail address (e.g.
   `your.company@gmail.com`).
4. Optionally set **From Name** (e.g. `NextRH Notifications`) — this becomes
   the display name in the recipient's inbox.
5. Click **Back to canvas**, then **Publish** the workflow (top-right).
   - The workflow MUST be re-published after editing — unpublished changes are
     ignored by the production webhook URL.

### 4.3 — Verify n8n End-to-End

Trigger a test notification (creates an in-app row + pushes to n8n + sends
mail + marks `email_sent=true`):

```powershell
# Find a real user UUID first
docker exec -i cv-postgres psql -U postgres -d cv_management `
  -c "SELECT user_id, email FROM users LIMIT 5;"

# Trigger a notification (replace <USER_UUID> with one from above)
Invoke-RestMethod -Uri http://localhost:3000/webhooks/notifications `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-webhook-secret" = "nextrh-n8n-secret" } `
  -Body '{"userId":"<USER_UUID>","type":"test","title":"Gmail migration test","message":"If you got this email in Gmail, the migration works."}'
```

Then in n8n: **Executions** tab → confirm the run is green at every node,
and the recipient inbox got the email.

### 4.4 — (Optional) Restart n8n

n8n picks up credential changes immediately, so a restart is **not required**.
If you want to be paranoid:

```powershell
docker compose restart n8n
```

---

## 5. Troubleshooting

| Error / Symptom | Cause | Fix |
|---|---|---|
| `535-5.7.8 Username and Password not accepted` | Using your regular Gmail password instead of an App Password. | Generate an App Password (step 2.2) and paste with no spaces. |
| `534-5.7.9 Application-specific password required` | 2-Step Verification is on but you used the account password. | Same fix — use an App Password. |
| `530-5.7.0 Authentication Required` | Wrong `MAIL_USER` (must be the full Gmail address). | Set `MAIL_USER=full.address@gmail.com`. |
| `connect ETIMEDOUT smtp.gmail.com:587` | Firewall / corporate network blocks port 587. | Try port 465 with `MAIL_SECURE=true`, or whitelist 587 outbound. |
| Email is sent but recipient sees a different `From:` | Gmail rewrites `From` to the authenticated account. | Set `MAIL_FROM_ADDRESS` equal to `MAIL_USER`, or configure a verified Gmail alias. |
| `553-5.7.1 The From header was rejected` | n8n's **Send Email** node has a `From Email` that isn't your Gmail address or a verified alias. | Update the **Send Notification Email** node (section 4.2) and re-publish. |
| Mail works in n8n but not for password reset (or vice-versa) | Only one of the two senders was reconfigured. | Both `backend/.env` **and** the n8n credential must be updated. |
| Daily quota exceeded (`550 5.4.5 Daily user sending limit exceeded`) | Hit Gmail's ~500/day (personal) or ~2,000/day (Workspace) cap. | Move to a transactional provider (SendGrid, Mailgun, SES). Code requires no changes — only env vars. |

---

## 6. Quick Migration Checklist

- [ ] 2-Step Verification enabled on the Gmail account
- [ ] App Password generated at https://myaccount.google.com/apppasswords
- [ ] `backend/.env` updated with Gmail host/port/user/password/from
- [ ] Backend restarted
- [ ] "Forgot Password" tested end-to-end (real email arrives in Gmail)
- [ ] n8n `NextRH SMTP` credential updated to `smtp.gmail.com:587` + App Password
- [ ] n8n **Send Notification Email** node `From Email` updated to the Gmail address
- [ ] n8n workflow **re-published**
- [ ] Test notification sent via `/webhooks/notifications` and email received
- [ ] (Optional) Old Mailtrap credentials deleted from password manager / n8n

Once every box is ticked, the Mailtrap → Gmail migration is complete.
