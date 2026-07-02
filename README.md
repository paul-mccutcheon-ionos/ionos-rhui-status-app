# IONOS RHUI Status

A dashboard for IONOS customers to check whether the IONOS-operated RHUI (Red Hat Update Infrastructure) is actually
delivering updates.

**This app has no direct access to the RHUI servers themselves.** Instead, you point it at one or more RHUI *test
clients* — ordinary RHEL 8 / RHEL 9 VMs already registered to pull updates from IONOS RHUI. The app SSHes into each
test client and runs the same checks a real `dnf update` would run, so what you see is exactly what a customer's
server experiences:

- **RHUI repo discovery** — reads the client's own `/etc/yum.repos.d/*.repo` files to find its actual RHUI config
- **DNS resolution** — can the client resolve the RHUI server's hostname?
- **Server certificate** — the TLS certificate the RHUI server presents to the client, and its expiry
- **Client entitlement certificate** — the certificate the client uses to authenticate to RHUI (the one that most
  commonly expires and silently breaks updates)
- **Live metadata fetch** — actually downloads `repodata/repomd.xml` from the RHUI server the same way yum/dnf would
- **Freshness vs. the public Red Hat CDN** — how far behind the public Red Hat mirrors the RHUI repo is (optional,
  requires a manual repo mapping since there's no way to derive the public URL from a private RHUI baseurl)
- **Live update check** — runs `dnf check-update` restricted to the discovered RHUI repos and surfaces the real
  output, success/failure, and exit code

Every check is labeled in the UI with a one-line explanation of what it means and why it matters.

## Configuration

Copy `.env.example` to `.env` and fill in your test client details, or leave `.env` absent and use the in-app
**Configuration** form (top-right banner: **Upload .env** to load a file directly, or fill in the form manually).
Form-submitted values live in server memory only, unless you click **Save to .env**. You can configure just RHEL 8,
just RHEL 9, or both.

Key settings:

| Variable | Purpose |
|---|---|
| `RHEL8_HOST` / `RHEL9_HOST` | Private IP or hostname of the RHUI test client (not the RHUI server) |
| `RHEL8_SSH_USER` / `RHEL9_SSH_USER` | SSH login user on the test client |
| `RHEL8_SSH_KEY_PATH` / `RHEL9_SSH_KEY_PATH` | Path to a private key file on the app server (recommended) |
| `RHEL8_SSH_KEY_CONTENT` / `RHEL9_SSH_KEY_CONTENT` | Alternative to the path: paste the PEM key content |
| `RHUI_REPO_FILTER` | Substring match used to pick RHUI repos out of the client's configured repos (default `rhui`) |
| `RHUI_MONITORED_REPOS` | `repoId|publicRepomdUrl` entries, separated by `;`, for optional public-CDN freshness comparison |

See `.env.example` for the full list and defaults.

## Running

```bash
npm install
npm start
```

The app itself listens on `PORT` (default `3006`, internal-only).

## Deployment

Deployed on `web1`, managed by `pm2` (see `deploy/ecosystem.config.js`) and reverse-proxied by nginx (see `deploy/nginx-rhui-status.conf`), matching the pattern used by the other apps on that host. Reachable externally via the IONOS Application Load Balancer at `http://85.215.173.84:8085`, which forwards to `web1`'s nginx on port `8085`, which in turn proxies to the app on `127.0.0.1:3006`.
