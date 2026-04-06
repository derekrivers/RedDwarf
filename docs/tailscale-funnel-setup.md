# Tailscale Funnel Setup for RedDwarf

This guide configures Tailscale Funnel so the RedDwarf operator API is reachable from GitHub Actions runners. This is required for the Project Mode merge-driven workflow (Feature 148), where a GitHub Actions workflow calls `POST /projects/advance` on PR merge.

## Prerequisites

- A Tailscale account (free tier is sufficient)
- The RedDwarf operator API running on the host (default port 8080)
- Admin access to your Tailnet's ACL policy (for Funnel enablement)

## 1. Install Tailscale

### Ubuntu / WSL2

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### Verify installation

```bash
tailscale version
```

## 2. Authenticate and connect

```bash
sudo tailscale up
```

Follow the browser-based authentication flow. Once connected:

```bash
tailscale status
```

Note your machine name (e.g., `reddwarf-dev`) and Tailnet domain (e.g., `yourname.ts.net`).

## 3. Enable Funnel in your Tailnet ACL

Funnel must be explicitly enabled in your Tailnet's ACL policy. Go to the [Tailscale admin console](https://login.tailscale.com/admin/acls), and add:

```json
{
  "nodeAttrs": [
    {
      "target": ["autogroup:member"],
      "attr": ["funnel"]
    }
  ]
}
```

This allows any machine in your Tailnet to use Funnel. You can restrict it to specific machines if preferred.

## 4. Serve the operator API via Funnel

```bash
# Expose the operator API (port 8080) publicly via Funnel on port 443
sudo tailscale funnel --bg 8080
```

This creates a public HTTPS endpoint at:

```
https://<machine-name>.<tailnet>.ts.net/
```

Verify it works:

```bash
curl https://<machine-name>.<tailnet>.ts.net/health
```

You should get a JSON response with the operator API health status.

## 5. Configure RedDwarf

Add the Funnel URL to your `.env`:

```bash
REDDWARF_OPERATOR_API_URL=https://<machine-name>.<tailnet>.ts.net
```

## 6. Configure GitHub Actions settings

In your GitHub repository settings, add the operator token as a secret and the
operator API URL as either a repository variable or a secret:

| Setting | Recommended location | Value |
|---------|----------------------|-------|
| `REDDWARF_OPERATOR_TOKEN` | Secret | Your operator API token (same as in `.env`) |
| `REDDWARF_OPERATOR_API_URL` | Variable, or Secret if you prefer | The Tailscale Funnel URL from step 5 |

These are consumed by the `.github/workflows/reddwarf-advance.yml` workflow
(Feature 148). The workflow accepts `REDDWARF_OPERATOR_API_URL` from either
repository variables or secrets and trims a trailing slash before calling
`/projects/advance`.

## 7. Verify end-to-end connectivity

From any external network (or use a GitHub Actions workflow):

```bash
curl -s \
  -H "Authorization: Bearer <REDDWARF_OPERATOR_TOKEN>" \
  https://<machine-name>.<tailnet>.ts.net/health
```

## Troubleshooting

### Funnel returns 502 Bad Gateway

The operator API is not running on the expected port. Verify:

```bash
curl http://127.0.0.1:8080/health
```

If this fails, start the RedDwarf stack first.

### `tailscale funnel` says "Funnel not available"

Funnel is not enabled in your Tailnet ACL. See step 3.

### WSL2-specific: Tailscale daemon not running

```bash
sudo tailscaled --tun=userspace-networking &
sudo tailscale up
```

WSL2 may require userspace networking mode since it lacks full kernel TUN support.

## Security notes

- Funnel exposes the operator API to the public internet. All routes except `/health` require `REDDWARF_OPERATOR_TOKEN` authentication.
- The Funnel URL uses TLS (HTTPS) with a valid certificate managed by Tailscale.
- To stop Funnel access: `sudo tailscale funnel --bg off`
