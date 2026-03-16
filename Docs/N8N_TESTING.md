# N8N Testing Guide (NextRH)

This guide explains how to **test n8n end‑to‑end** and confirm that the workflow is working correctly with the current NextRH architecture (backend local + n8n in Docker).

---

## 1. Preconditions

- n8n is running:
  ```powershell
  docker ps | findstr n8n
  ```
- n8n health check is OK:
  ```powershell
  Invoke-RestMethod http://localhost:5678/healthz
  ```
- Backend is running locally on port `3000` with env vars:
  ```
  N8N_WEBHOOK_URL=http://localhost:5678/webhook/nextrh-notification
  N8N_WEBHOOK_SECRET=nextrh-n8n-secret
  ```

---

## 2. Confirm Workflow Is Published

1. Open n8n UI: `http://localhost:5678`
2. Open the workflow.
3. Ensure top‑right shows **Published** (green dot).
   - Do **not** click “Execute workflow” for production tests.

---

## 3. Check Webhook URL (Production)

In the **Webhook** node:

- Production URL must be:
  ```
  http://localhost:5678/webhook/nextrh-notification
  ```
- Do **not** use `/webhook-test/...` for production runs.

---

## 4. Validate IF Condition (Has Email?)

- **Type**: String
- **Value 1**:
  ```
  {{ $json.body.userEmail }}
  ```
- **Operation**: is not empty

Publish after changes.

---

## 5. Validate Send Email Node

In **Send Notification Email**:
- **To Email**: `{{ $json.body.userEmail }}`
- **Subject**: `{{ $json.body.title }}`
- **HTML body** should use `{{ $json.body.* }}` fields.

Example snippet:

```html
<h2>{{ $json.body.title }}</h2>
<p>{{ $json.body.message }}</p>
<a href="http://localhost:5173/login">Open NextRH</a>
```

---

## 6. Validate Mark Email Sent Node

Because n8n is in Docker and backend is local, use:

```
http://host.docker.internal:3000/webhooks/notifications/{{ $node["Webhook"].json.body.notificationId }}/email-sent
```

Make sure there are **no line breaks** in the URL field.

Add header:
```
x-webhook-secret: nextrh-n8n-secret
```

Publish after changes.

---

## 7. Trigger a Real Test

Send a real webhook from the backend:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/webhooks/notifications" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-webhook-secret" = "nextrh-n8n-secret" } `
  -Body '{"userId":"<USER_UUID>","type":"certification_expiring","title":"Test: AWS cert expires in 20 days","message":"Your AWS Solutions Architect certification expires on April 1, 2026. Please renew it."}'
```

---

## 8. Verify Execution in n8n

1. Go to **Executions**.
2. Open the latest run.
3. You should see all nodes executed:
   - Webhook → Has Email? → Send Email → Mark Email Sent

If **Send Email** does not appear, the IF condition is wrong.

---

## 9. Verify Email Delivery

Check your SMTP inbox (Mailtrap or real mailbox).  
If no email arrives, open the **Send Notification Email** node in the execution and read the **Error** panel.

---

## 10. Verify Database Update

Replace `<NOTIF_ID>` with the ID returned by the webhook call:

```powershell
docker exec -i cv-postgres psql -U postgres -d cv_management `
  -c "SELECT notification_id, email_sent FROM notifications WHERE notification_id='<NOTIF_ID>';"
```

Expected:
```
email_sent = true
```

---

## 11. Common Failure Modes

- **No executions**: workflow not published, or backend calling `/webhook-test`.
- **Has Email? error**: condition type set to Boolean instead of String.
- **DNS error on Mark Email Sent**: use `host.docker.internal` when backend is local.
- **404 on Mark Email Sent**: wrong URL or missing `notificationId`.
- **No email**: SMTP credentials invalid or Send Email node misconfigured.
