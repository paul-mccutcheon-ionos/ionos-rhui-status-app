# IONOS RHUI Status

A dashboard for IONOS customers to check whether the IONOS-operated RHUI (Red Hat Update Infrastructure) is actually
delivering updates.

**This app has no direct access to the RHUI servers themselves.** Instead, you point it at one or more RHUI *test
clients* — ordinary RHEL VMs pre-configured by IONOS to pull updates from IONOS RHUI (any RHEL release; the app
detects it automatically once connected). Test clients can be found automatically via the **IONOS Cloud API** (search
your VM inventory by contract, detect RHEL hosts by volume `licenceType`, then pick one/many/all) or entered manually.
The app SSHes into each test client and runs the same checks a real `dnf update` would run, so what you see is
exactly what a customer's server experiences. A host selector appears in the dashboard when more than one host is
configured. Checks are split into two groups in the UI:

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
- **Mirrorlist duplicate-path detection** — catches a known IONOS RHUI backend bug where the mirrorlist endpoint
  resolves to a URL with a repeated path segment (e.g. `.../pulp/content/content/dist/...`), which 404s on every
  fetch. Flagged as an issue with a one-click fix that applies the standard support workaround: switch that one repo
  from `mirrorlist=` to a hardcoded `baseurl=` with the duplicate segment collapsed.

Every check is labeled in the UI with a one-line explanation of what it means and why it matters.

## Configuration

Copy `.env.example` to `.env` and fill in your test client details, or leave `.env` absent and use the **RHEL Client
Connection** page in the sidebar (top-right banner: **Upload .env** to load a file directly, or fill in the form
manually). Configuration is kept in server memory only for the life of the process and is **never written to
disk** — if the app restarts, or you open a fresh session, you'll need to upload your `.env` (or re-fill the form)
again. Opening the connection page pre-populates every field (including SSH keys and the IONOS API token) from
whatever is currently loaded in memory.

### Finding hosts via the IONOS Cloud API

Enter an IONOS Cloud API token (and, for reseller/admin tokens acting on another contract, a contract number — sent
as `X-Contract-Number`) and click **Discover RHEL hosts**. This searches every datacenter visible to the token for
servers whose boot volume `licenceType` is `RHEL` (the same field IONOS sets internally based on the image/snapshot
used at creation — reliable even for private images that don't resolve via the public image catalog), falling back
to image alias/name matching. Check the ones you want to monitor, or add hosts manually below — both feed the same
"Hosts to monitor" list.

### SSH access: one key for everyone, or one per host

Toggle **"Use the same SSH user/key for every host"** to apply one set of credentials to every selected/added host,
or untick it to give each host its own user/port/key/passphrase (useful when discovered hosts don't all use the same
key). Either way, `Host / IP` is editable per host in case the discovered IP isn't the one you want to use.

Key settings (`.env`):

| Variable | Purpose |
|---|---|
| `IONOS_API_TOKEN` | IONOS Cloud API bearer token, used for host discovery |
| `IONOS_CONTRACT_NUMBER` | Optional, for reseller/admin tokens acting on another contract |
| `RHUI_HOSTS_JSON` | JSON array of hosts to monitor (label/host/port/username/keyPath/keyContent/passphrase each) |
| `RHUI_REPO_FILTER` | Substring match used to pick RHUI repos out of each client's configured repos (default `rhui`) |
| `RHUI_MONITORED_REPOS` | `repoId|publicRepomdUrl` entries, separated by `;`, for optional public-CDN freshness comparison |

See `.env.example` for the full list, defaults, and the `RHUI_HOSTS_JSON` shape. Since this app never writes
configuration to disk, `.env` is meant to be prepared once (by hand, or by exporting the setup form's state) and
supplied at deploy time or via the **Upload .env** button — not generated by the app itself.

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
