# IONOS RHUI Status

A dashboard for monitoring the internal Red Hat Update Infrastructure (RHUI) servers at IONOS. It reports, per RHEL 8 / RHEL 9 host:

- **Infrastructure availability** — SSH reachability and latency
- **Service health** — status of key RHUI services (pulpcore, httpd, nginx, squid, etc.)
- **Data availability** — disk usage of the RHUI content store
- **Update freshness** — local repo sync revision vs. the corresponding repo on the public Red Hat CDN, with lag in hours
- **Entitlement certificate expiry**
- **Uptime / load**

## Configuration

Copy `.env.example` to `.env` and fill in your host details, or leave `.env` absent and use the in-app **Configuration** form (top-right banner: **Upload .env** to load a file directly, or fill in the form manually). Form-submitted values live in server memory only, unless you click **Save to .env**.

Key settings:

| Variable | Purpose |
|---|---|
| `RHEL8_HOST` / `RHEL9_HOST` | Private IP or hostname of each RHUI VM |
| `RHEL8_SSH_USER` / `RHEL9_SSH_USER` | SSH login user |
| `RHEL8_SSH_KEY_PATH` / `RHEL9_SSH_KEY_PATH` | Path to a private key file on the app server (recommended) |
| `RHEL8_SSH_KEY_CONTENT` / `RHEL9_SSH_KEY_CONTENT` | Alternative to the path: paste the PEM key content |
| `RHUI_SERVICES` | Comma-separated systemd services to check |
| `RHUI_DATA_PATH` | Path used for disk/data availability checks |
| `RHUI_ENTITLEMENT_CERT_PATH` | Path to the entitlement cert for expiry checks |
| `RHUI_MONITORED_REPOS` | `repoId|localRepomdPath|publicRepomdUrl` entries, separated by `;`, compared against the public Red Hat CDN |

See `.env.example` for the full list and defaults.

## Running

```bash
npm install
npm start
```

The app itself listens on `PORT` (default `3006`, internal-only).

## Deployment

Deployed on `web1`, managed by `pm2` (see `deploy/ecosystem.config.js`) and reverse-proxied by nginx (see `deploy/nginx-rhui-status.conf`), matching the pattern used by the other apps on that host. Reachable externally via the IONOS Application Load Balancer at `http://85.215.173.84:8085`, which forwards to `web1`'s nginx on port `8085`, which in turn proxies to the app on `127.0.0.1:3006`.
