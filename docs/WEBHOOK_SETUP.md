# GitHub Webhook Setup

This guide covers configuring GitHub webhooks for RedDwarf so that new issues
trigger the intake pipeline immediately instead of waiting for the next poll
cycle. Webhooks are optional — polling works without them.

## Prerequisites

- RedDwarf operator API accessible from the internet (or from GitHub's
  webhook delivery IPs)
- A GitHub repository already registered in RedDwarf (`/repos` endpoint or
  dashboard)

## 1. Generate a webhook secret

```bash
openssl rand -hex 32
```

Save the output — you will use it in both GitHub and your `.env`.

## 2. Set environment variables

Add to your `.env` (or export before starting the stack):

```bash
# Required: enables webhook receiver and HMAC verification
REDDWARF_WEBHOOK_SECRET=<your-secret-from-step-1>

# Optional: custom webhook route path (default: /webhooks/github)
# REDDWARF_WEBHOOK_PATH=/webhooks/github

# Optional: polling mode (default: auto)
# auto  = disable polling when webhook secret is set (recommended)
# always = keep polling alongside webhooks (belt-and-suspenders)
# never  = never poll regardless of webhook config
REDDWARF_POLL_MODE=auto
```

## 3. Create the webhook in GitHub

1. Go to your repository **Settings > Webhooks > Add webhook**
2. **Payload URL**: `https://<your-vps>:8080/webhooks/github`
   (or whatever `REDDWARF_API_PORT` and `REDDWARF_WEBHOOK_PATH` resolve to)
3. **Content type**: `application/json`
4. **Secret**: paste the same secret from step 1
5. **Which events?**: select **Let me select individual events**, then check
   only **Issues**
6. **Active**: checked
7. Click **Add webhook**

GitHub will send a `ping` event immediately. Check your RedDwarf logs for
`WEBHOOK_PING` to confirm delivery.

## 4. Verify it's working

### Health endpoint

```bash
curl -s http://<your-vps>:8080/health | jq '.intakeMode'
```

Expected output: `"webhook"` (or `"webhook+polling"` if `REDDWARF_POLL_MODE=always`).

### Logs

When a new issue with the `ai-eligible` label is opened, you should see:

```
WEBHOOK_ISSUE_RECEIVED  repo=owner/repo  issueNumber=42
WEBHOOK_PIPELINE_COMPLETED  taskId=...  runId=...
```

### Test with a dummy issue

Open a test issue with the `ai-eligible` label in your repo. The pipeline
should start within seconds (vs. the 30-second poll cycle default).

## 5. Reverse proxy (nginx)

If the operator API sits behind nginx, forward the webhook path and keep
other routes private:

```nginx
server {
    listen 443 ssl;
    server_name reddwarf.example.com;

    # Public: webhook receiver and health check
    location /webhooks/github {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:8080;
    }

    # Private: all other routes require VPN / firewall
    location / {
        # Option A: restrict to internal network
        allow 10.0.0.0/8;
        deny all;

        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 6. Local development with smee.io

For testing webhooks locally without exposing your machine:

```bash
# Install smee client
npm install -g smee-client

# Create a channel at https://smee.io and copy the URL
smee --url https://smee.io/<your-channel-id> --target http://127.0.0.1:8080/webhooks/github
```

Then configure the GitHub webhook to point at your smee.io URL instead of
your local machine. Events will be proxied through.

Alternatively, use the GitHub CLI:

```bash
# Forward webhook events to your local server
gh webhook forward --repo=owner/repo --events=issues \
  --url=http://127.0.0.1:8080/webhooks/github \
  --secret=<your-webhook-secret>
```

## Security notes

- The webhook route uses HMAC-SHA256 verification via `X-Hub-Signature-256`.
  Requests with missing or invalid signatures are rejected with 401.
- The webhook route does **not** require the operator bearer token — it has
  its own authentication via the shared secret.
- Only `issues` events with `action: opened` trigger the intake pipeline.
  All other events are acknowledged with 200 but ignored.
- The intake pipeline's existing deduplication guard (`hasPlanningSpecForSource`)
  prevents the same issue from being processed twice, even if both webhook
  and polling are active simultaneously (`REDDWARF_POLL_MODE=always`).
