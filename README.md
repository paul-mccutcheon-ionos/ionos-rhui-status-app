# IONOS RHUI Status

A dashboard for IONOS customers to check whether the IONOS-operated RHUI (Red Hat Update Infrastructure) is actually
delivering updates.

**This app has no direct access to the RHUI servers themselves.** Instead, you point it at a single RHUI *test
client* — an ordinary RHEL VM pre-configured by IONOS to pull updates from IONOS RHUI (any RHEL release; the app
detects it automatically once connected). The app SSHes into the test client and runs the same checks a real
`dnf update` would run, so what you see is exactly what a customer's server experiences. Checks are split into two
groups in the UI:

**RHUI server-side** (the basics, as observed by the client — deduplicated per unique RHUI hostname, since a client
typically talks to one RHUI server for all its repos):
- **DNS resolution** of the RHUI server's hostname
- **Ping** (informational only — many cloud firewalls block ICMP even when the service is healthy)
- **Server certificate** validity and expiry

**RHUI client-side configuration** (the client's own setup — usually where real problems live):
- **RHUI repo discovery** — reads `/etc/yum.repos.d/*.repo`, handling both `baseurl=` and IONOS's `mirrorlist=` repos,
  with `$releasever`/`$basearch` substitution so URLs are built exactly as dnf builds them
- **Enabled/disabled state per repo**, with a one-click fix (`dnf config-manager --set-enabled ...`) run over SSH if
  the app has root or passwordless-sudo access — this directly fixes the most common real-world failure mode
- **Client entitlement certificate** validity and expiry (the certificate that most commonly expires and silently
  breaks updates)
- **Live metadata fetch** — actually downloads `repodata/repomd.xml` (resolving the mirrorlist first, if used) using
  the client's real certificates
- **Freshness vs. the public Red Hat CDN** — optional, requires a manual repo mapping since there's no way to derive
  the public URL from a private RHUI mirrorlist/baseurl
- **Subscription Manager status** — correctly treats `Overall Status: Unknown` / not-registered as the *expected,
  correct* state for an IONOS RHUI-managed host, and only flags a problem if the host looks registered directly with
  Red Hat (risk of double-billing)
- **Live update check** — runs `dnf check-update` (restricted to primary, non-debug/source repos to stay fast) and
  surfaces the real output, success/failure, and exit code

Every check is labeled in the UI with a one-line explanation of what it means and why it matters.

## Configuration

Copy `.env.example` to `.env` and fill in your test client details, or leave `.env` absent and use the in-app
**Configuration** form (top-right banner: **Upload .env** to load a file directly, or fill in the form manually).
Form-submitted values live in server memory only, unless you click **Save to .env**.

Key settings:

| Variable | Purpose |
|---|---|
| `HOST_HOST` | Private IP or hostname of the RHUI test client (not the RHUI server) |
| `HOST_SSH_USER` | SSH login user on the test client |
| `HOST_SSH_KEY_PATH` | Path to a private key file on the app server (recommended) |
| `HOST_SSH_KEY_CONTENT` | Alternative to the path: paste the PEM key content |
| `RHUI_REPO_FILTER` | Substring match used to pick RHUI repos out of the client's configured repos (default `rhui`) |
| `RHUI_MONITORED_REPOS` | `repoId|publicRepomdUrl` entries, separated by `;`, for optional public-CDN freshness comparison |

See `.env.example` for the full list and defaults.

### Root / sudo access for remediation and full diagnostics

Some checks and the one-click "enable disabled repos" fix need to run `dnf`, `subscription-manager`, and read
protected files under `/etc/pki/rhui/`. If the configured SSH user is `root`, commands run directly; otherwise the
app prefixes them with `sudo -n` (non-interactive), which requires the user to have passwordless sudo configured for
those commands. Without root/sudo, most checks still work (repo discovery, DNS, ping, server certificate, live
metadata fetch) but the client certificate check, subscription-manager check, live update check, and repo-enabling
fix will fail or be skipped.

## Running

```bash
npm install
npm start
```

The app itself listens on `PORT` (default `3006`, internal-only).

## Deployment

Deployed on `web1`, managed by `pm2` (see `deploy/ecosystem.config.js`) and reverse-proxied by nginx (see `deploy/nginx-rhui-status.conf`), matching the pattern used by the other apps on that host. Reachable externally via the IONOS Application Load Balancer at `http://85.215.173.84:8085`, which forwards to `web1`'s nginx on port `8085`, which in turn proxies to the app on `127.0.0.1:3006`.
