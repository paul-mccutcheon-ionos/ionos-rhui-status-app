const axios = require('axios');
const ssh = require('./sshService');

// IMPORTANT ARCHITECTURE NOTE
// We do not have access to the IONOS RHUI servers themselves. The RHEL 8/9
// hosts configured in this app are RHUI *clients* -- ordinary customer VMs,
// pre-configured by IONOS to pull updates from IONOS's internal RHUI
// infrastructure. Every check below runs commands on that client (over SSH)
// to reproduce exactly what a real customer's `yum`/`dnf` sees.
//
// Checks are split into two categories, shown separately in the UI:
//  - "server-side": the basics about the RHUI server itself, as observed by
//    the client -- DNS, ping, and TLS certificate validity.
//  - "client-side": the client's own configuration -- which RHUI repos it
//    has, whether they're enabled, whether its entitlement certificate is
//    still valid, whether it can actually fetch metadata, and whether a real
//    "dnf check-update" succeeds. Problems here are the most common cause of
//    "updates aren't working" and, where possible, this app can fix them
//    directly (e.g. re-enabling a disabled repo) if given root/sudo access.

function parseRepomdRevision(xml) {
  if (!xml) return null;
  const match = xml.match(/<revision>(\d+)<\/revision>/);
  if (!match) return null;
  const epoch = parseInt(match[1], 10);
  if (Number.isNaN(epoch)) return null;
  return new Date(epoch * 1000);
}

function parseOpenSslDate(line) {
  if (!line) return null;
  const d = new Date(line.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

// Root SSH users run commands directly; non-root users need passwordless
// sudo for the commands that touch protected RHUI cert files or run
// dnf/subscription-manager. `-n` makes sudo fail fast instead of hanging on
// a password prompt if it isn't configured.
function withSudo(hostCfg, cmd) {
  return hostCfg.username === 'root' ? cmd : `sudo -n ${cmd}`;
}

function buildCertArgs(repo) {
  const certArgs = [];
  if (repo.sslcacert) certArgs.push(`--cacert ${repo.sslcacert}`);
  if (repo.sslclientcert && repo.sslclientkey) certArgs.push(`--cert ${repo.sslclientcert} --key ${repo.sslclientkey}`);
  if (repo.sslverify === '0' || (repo.sslverify || '').toLowerCase() === 'no') certArgs.push('-k');
  return certArgs;
}

async function checkClientReachable(hostCfg, timeoutMs) {
  const start = Date.now();
  try {
    const conn = await ssh.connect(hostCfg, timeoutMs);
    const latencyMs = Date.now() - start;
    conn.end();
    return { reachable: true, latencyMs, error: null };
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err.message };
  }
}

async function getOsRelease(conn, timeoutMs) {
  const { stdout } = await ssh.exec(conn, 'cat /etc/redhat-release 2>/dev/null', timeoutMs);
  return stdout.trim() || 'unknown';
}

// Reads every *.repo file on the client and returns the repo sections whose
// id or URL mentions the RHUI filter string. IONOS RHUI repos are defined
// with `mirrorlist=`, not `baseurl=` -- yum/dnf resolves the mirrorlist to an
// actual content URL at request time, so both forms are handled.
function parseRepoFiles(rawText, filter) {
  const repos = [];
  const fileBlocks = rawText.split(/^==>\s*(.+?)\s*<==$/m);
  for (let i = 1; i < fileBlocks.length; i += 2) {
    const file = fileBlocks[i];
    const content = fileBlocks[i + 1] || '';
    const sectionRe = /\[([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g;
    let m;
    while ((m = sectionRe.exec(content))) {
      const id = m[1].trim();
      const body = m[2];
      const get = (key) => {
        const km = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'mi'));
        return km ? km[1].trim() : null;
      };
      const baseurl = get('baseurl');
      const mirrorlist = get('mirrorlist');
      if (!baseurl && !mirrorlist) continue;
      const haystack = `${id} ${baseurl || ''} ${mirrorlist || ''}`.toLowerCase();
      if (filter && !haystack.includes(filter.toLowerCase())) continue;
      repos.push({
        id,
        file,
        baseurl,
        mirrorlist,
        enabled: get('enabled') !== '0',
        sslcacert: get('sslcacert'),
        sslclientcert: get('sslclientcert'),
        sslclientkey: get('sslclientkey'),
        sslverify: get('sslverify'),
      });
    }
  }
  return repos;
}

async function discoverRhuiRepos(conn, repoFilter, timeoutMs) {
  const { stdout } = await ssh.exec(
    conn,
    'for f in /etc/yum.repos.d/*.repo; do [ -f "$f" ] && echo "==> $f <==" && cat "$f"; done 2>/dev/null',
    timeoutMs
  );
  return parseRepoFiles(stdout, repoFilter);
}

// dnf/yum repo URLs use $releasever/$basearch placeholders, substituted at
// request time. We must do the same substitution before making our own
// requests, or every URL is malformed and RHUI (correctly) rejects it --
// which looks exactly like a permissions problem but isn't one.
async function getDnfVars(conn, timeoutMs) {
  const { stdout } = await ssh.exec(conn, "rpm -E %{rhel} 2>/dev/null; uname -m 2>/dev/null", timeoutMs);
  const [releasever, basearch] = stdout.trim().split('\n').map((s) => s.trim());
  return { releasever: releasever || null, basearch: basearch || null };
}

function substituteDnfVars(url, vars) {
  if (!url) return url;
  return url
    .replace(/\$\{?releasever\}?/g, vars.releasever || '$releasever')
    .replace(/\$\{?basearch\}?/g, vars.basearch || '$basearch');
}

function hostAndPortFromUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80 };
  } catch (err) {
    return null;
  }
}

async function checkDnsResolution(conn, host, timeoutMs) {
  try {
    const { stdout, code } = await ssh.exec(conn, `getent hosts ${host} 2>&1`, timeoutMs);
    if (code !== 0 || !stdout.trim()) {
      return { host, resolved: false, error: stdout.trim() || 'not found' };
    }
    const ip = stdout.trim().split(/\s+/)[0];
    return { host, resolved: true, ip };
  } catch (err) {
    return { host, resolved: false, error: err.message };
  }
}

// ICMP is frequently blocked by cloud firewalls even when the service itself
// is perfectly healthy, so this is reported as informational, not a pass/fail.
async function checkPing(conn, host, timeoutMs) {
  try {
    const { stdout, code } = await ssh.exec(conn, `ping -c 2 -W 2 ${host} 2>&1`, timeoutMs);
    const rttMatch = stdout.match(/= [\d.]+\/([\d.]+)\/[\d.]+/);
    return {
      host,
      responded: code === 0,
      avgRttMs: rttMatch ? parseFloat(rttMatch[1]) : null,
      note: code === 0 ? null : 'No ping response -- this is often normal if ICMP is firewalled, and does not by itself indicate a problem.',
    };
  } catch (err) {
    return { host, responded: false, error: err.message };
  }
}

// Fetches the RHUI server's TLS certificate exactly as the client sees it,
// by running the TLS handshake ON the client -- this app typically has no
// network path to IONOS's private RHUI network at all.
async function checkServerCertificate(conn, host, port, timeoutMs) {
  const cmd = `timeout 10 openssl s_client -connect ${host}:${port} -servername ${host} </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null`;
  try {
    const { stdout } = await ssh.exec(conn, cmd, timeoutMs);
    if (!stdout.trim()) {
      return { host, port, found: false, error: 'No certificate returned (connection failed or handshake refused)' };
    }
    const subject = (stdout.match(/^subject=(.*)$/m) || [])[1] || null;
    const issuer = (stdout.match(/^issuer=(.*)$/m) || [])[1] || null;
    const notBefore = parseOpenSslDate((stdout.match(/^notBefore=(.*)$/m) || [])[1]);
    const notAfter = parseOpenSslDate((stdout.match(/^notAfter=(.*)$/m) || [])[1]);
    const daysRemaining = notAfter ? Math.round((notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
    return {
      host,
      port,
      found: true,
      subject,
      issuer,
      notBefore,
      notAfter,
      daysRemaining,
      expired: daysRemaining != null ? daysRemaining < 0 : null,
    };
  } catch (err) {
    return { host, port, found: false, error: err.message };
  }
}

// RHUI authenticates clients with a per-client SSL certificate (referenced by
// `sslclientcert` in the repo file). This is the certificate that commonly
// expires on a fixed schedule and silently breaks updates with a TLS/auth
// error that looks like a network problem.
async function checkClientCertificate(conn, hostCfg, certPath, timeoutMs) {
  if (!certPath) {
    return { path: null, found: false, error: 'Repo files do not reference a client (sslclientcert) certificate' };
  }
  try {
    const { stdout, code } = await ssh.exec(conn, withSudo(hostCfg, `openssl x509 -enddate -subject -noout -in ${certPath} 2>&1`), timeoutMs);
    if (code !== 0 || !stdout.includes('notAfter=')) {
      return { path: certPath, found: false, error: stdout.trim() || 'certificate not found or unreadable' };
    }
    const subject = (stdout.match(/^subject=(.*)$/m) || [])[1] || null;
    const notAfter = parseOpenSslDate((stdout.match(/^notAfter=(.*)$/m) || [])[1]);
    const daysRemaining = notAfter ? Math.round((notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
    return {
      path: certPath,
      found: true,
      subject,
      notAfter,
      daysRemaining,
      expired: daysRemaining != null ? daysRemaining < 0 : null,
    };
  } catch (err) {
    return { path: certPath, found: false, error: err.message };
  }
}

async function curlFetch(conn, url, certArgs, timeoutMs) {
  const marker = '__HTTP_CODE__:';
  const cmd = `curl -s --connect-timeout 10 -m 20 ${certArgs.join(' ')} -w '\\n${marker}%{http_code}' "${url}" 2>&1`;
  const { stdout } = await ssh.exec(conn, cmd, timeoutMs);
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) {
    return { success: false, error: stdout.trim() || 'curl produced no output (connection likely failed)' };
  }
  const body = stdout.slice(0, idx).trim();
  const httpCode = stdout.slice(idx + marker.length).trim();
  if (httpCode !== '200') {
    return { success: false, httpCode, error: `HTTP ${httpCode}` };
  }
  return { success: true, httpCode, body };
}

// A mirrorlist is itself a small HTTPS resource that returns one URL per
// line; dnf resolves it at request time to pick an actual content mirror.
async function resolveMirrorlist(conn, repo, timeoutMs) {
  const result = await curlFetch(conn, repo.mirrorlist, buildCertArgs(repo), timeoutMs);
  if (!result.success) return { error: `mirrorlist fetch failed: ${result.error}` };
  const lines = result.body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { error: 'mirrorlist returned no usable mirror URLs' };
  return { mirrorUrl: lines[0], mirrorCount: lines.length };
}

// Actually fetches repodata/repomd.xml through the same path (mirrorlist
// resolution + client certificate, if configured) yum/dnf would use. Success
// here means the client can genuinely pull metadata right now.
async function checkLiveMetadataFetch(conn, repo, timeoutMs) {
  const certArgs = buildCertArgs(repo);
  let baseUrl = repo.baseurl;
  let mirrorInfo = null;

  if (!baseUrl && repo.mirrorlist) {
    mirrorInfo = await resolveMirrorlist(conn, repo, timeoutMs);
    if (mirrorInfo.error) {
      return { url: repo.mirrorlist, success: false, error: mirrorInfo.error };
    }
    baseUrl = mirrorInfo.mirrorUrl;
  }

  if (!baseUrl) {
    return { success: false, error: 'Repo has neither baseurl nor mirrorlist configured' };
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/repodata/repomd.xml`;
  try {
    const result = await curlFetch(conn, url, certArgs, timeoutMs);
    if (!result.success) {
      return { url, mirrorlistUrl: repo.mirrorlist, success: false, error: result.error };
    }
    return {
      url,
      mirrorlistUrl: repo.mirrorlist,
      mirrorCount: mirrorInfo && mirrorInfo.mirrorCount,
      success: true,
      localRevision: parseRepomdRevision(result.body),
    };
  } catch (err) {
    return { url, success: false, error: err.message };
  }
}

async function fetchPublicRepomd(url, timeoutMs) {
  const resp = await axios.get(url, { timeout: timeoutMs, responseType: 'text', transformResponse: [(d) => d] });
  return resp.data;
}

async function checkFreshnessVsPublicCdn(localRevision, repoId, monitoredRepos, timeoutMs) {
  const mapping = monitoredRepos.find((r) => r.repoId === repoId);
  if (!mapping) return null;
  const result = { publicUrl: mapping.publicRepomdUrl };
  try {
    const publicXml = await fetchPublicRepomd(mapping.publicRepomdUrl, timeoutMs);
    result.publicRevision = parseRepomdRevision(publicXml);
  } catch (err) {
    result.error = `public CDN fetch failed: ${err.message}`;
    return result;
  }
  if (localRevision && result.publicRevision) {
    result.lagSeconds = Math.round((result.publicRevision.getTime() - localRevision.getTime()) / 1000);
    result.inSync = result.lagSeconds <= 0;
  }
  return result;
}

// The ground-truth check: actually ask dnf to refresh metadata for the
// discovered RHUI repos, restricted to just those repos. `--enablerepo`
// force-enables them for this one command regardless of the persisted
// enabled= setting, so this measures whether RHUI itself is reachable,
// independent of whether the client is currently configured to use it.
async function checkLiveUpdateCheck(conn, hostCfg, repoIds, timeoutMs) {
  if (!repoIds.length) {
    return { ran: false, reason: 'No RHUI repos discovered to test' };
  }
  const enable = repoIds.map((id) => `--enablerepo=${id}`).join(' ');
  const cmd = withSudo(hostCfg, `timeout 90 dnf --disablerepo='*' ${enable} check-update 2>&1; echo __EXIT__:$?`);
  try {
    const { stdout } = await ssh.exec(conn, cmd, timeoutMs + 90000);
    const m = stdout.match(/__EXIT__:(\d+)/);
    const exitCode = m ? parseInt(m[1], 10) : null;
    const output = stdout.replace(/__EXIT__:\d+\s*$/, '').trim();
    // dnf check-update: 0 = success, no updates; 100 = success, updates available; other = failure
    const success = exitCode === 0 || exitCode === 100;
    return { ran: true, exitCode, success, updatesAvailable: exitCode === 100, output: output.slice(-4000) };
  } catch (err) {
    return { ran: true, success: false, error: err.message };
  }
}

// On an IONOS RHUI-managed VM, "Overall Status: Unknown" / not registered is
// the CORRECT and expected state -- it means the client is getting updates
// from RHUI rather than being registered directly with Red Hat. We flag it
// only if the host looks like it IS registered, which risks double-billing.
async function checkSubscriptionManager(conn, hostCfg, timeoutMs) {
  try {
    const { stdout } = await ssh.exec(conn, withSudo(hostCfg, 'subscription-manager status 2>&1'), timeoutMs);
    const overallStatus = (stdout.match(/Overall Status:\s*(.+)/) || [])[1] || null;
    const expectedForRhui = !overallStatus || /unknown/i.test(overallStatus) || /not registered/i.test(stdout);
    return { ran: true, overallStatus, expectedForRhui, raw: stdout.trim().slice(0, 2000) };
  } catch (err) {
    return { ran: false, error: err.message };
  }
}

function dedupeBy(items, keyFn) {
  const seen = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key && !seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function buildIssues(repos) {
  const issues = [];
  const disabled = repos.filter((r) => !r.enabled && !r.error);
  if (disabled.length) {
    issues.push({
      code: 'repos_disabled',
      severity: 'warning',
      message: `${disabled.length} RHUI repo(s) are disabled in the client's configuration, so dnf will not use them for updates even though RHUI itself may be working fine.`,
      repoIds: disabled.map((r) => r.id),
      fixId: 'enable-repos',
      fixLabel: `Enable ${disabled.length} disabled RHUI repo(s)`,
      fixCommand: `dnf config-manager --set-enabled ${disabled.map((r) => r.id).join(' ')}`,
    });
  }
  return issues;
}

async function checkHost(hostCfg, cfg) {
  const base = { label: hostCfg.label, host: hostCfg.host };

  if (!hostCfg.host || !hostCfg.username || (!hostCfg.keyPath && !hostCfg.keyContent)) {
    return { ...base, configured: false };
  }

  const connectivity = await checkClientReachable(hostCfg, cfg.sshTimeoutMs);
  if (!connectivity.reachable) {
    return { ...base, configured: true, connectivity, checkedAt: new Date() };
  }

  let conn;
  try {
    conn = await ssh.connect(hostCfg, cfg.sshTimeoutMs);
    const osRelease = await getOsRelease(conn, cfg.sshTimeoutMs);
    const dnfVars = await getDnfVars(conn, cfg.sshTimeoutMs);
    const discovered = (await discoverRhuiRepos(conn, cfg.repoFilter, cfg.sshTimeoutMs)).map((repo) => ({
      ...repo,
      baseurl: substituteDnfVars(repo.baseurl, dnfVars),
      mirrorlist: substituteDnfVars(repo.mirrorlist, dnfVars),
    }));

    // Checks below run sequentially (not Promise.all) because they all share
    // one SSH connection, and sshd's default MaxSessions caps how many
    // concurrent exec channels a single connection may open -- opening many
    // at once errors with "Channel open failure" rather than queuing.

    // Server-side checks: RHUI CDS hosts are shared across all a client's
    // RHUI repos, so DNS/ping/certificate are checked once per unique host.
    const uniqueServers = dedupeBy(
      discovered.map((r) => hostAndPortFromUrl(r.mirrorlist || r.baseurl)).filter(Boolean),
      (hp) => `${hp.host}:${hp.port}`
    );
    const serverChecks = [];
    for (const hp of uniqueServers) {
      serverChecks.push({
        host: hp.host,
        port: hp.port,
        // eslint-disable-next-line no-await-in-loop
        dns: await checkDnsResolution(conn, hp.host, cfg.sshTimeoutMs),
        // eslint-disable-next-line no-await-in-loop
        ping: await checkPing(conn, hp.host, cfg.sshTimeoutMs),
        // eslint-disable-next-line no-await-in-loop
        cert: await checkServerCertificate(conn, hp.host, hp.port, cfg.sshTimeoutMs),
      });
    }

    // Client-side: the entitlement cert path is also shared across repos, so
    // check each unique path once.
    const uniqueClientCertPaths = [...new Set(discovered.map((r) => r.sslclientcert).filter(Boolean))];
    const clientCertResults = {};
    for (const path of uniqueClientCertPaths) {
      // eslint-disable-next-line no-await-in-loop
      clientCertResults[path] = await checkClientCertificate(conn, hostCfg, path, cfg.sshTimeoutMs);
    }

    const repos = [];
    for (const repo of discovered) {
      const hp = hostAndPortFromUrl(repo.mirrorlist || repo.baseurl);
      if (!hp) {
        repos.push({ ...repo, error: `Could not parse repo URL: ${repo.mirrorlist || repo.baseurl}` });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const liveFetch = await checkLiveMetadataFetch(conn, repo, cfg.sshTimeoutMs);
      const freshness = liveFetch.success
        // eslint-disable-next-line no-await-in-loop
        ? await checkFreshnessVsPublicCdn(liveFetch.localRevision, repo.id, cfg.monitoredRepos, cfg.cdnTimeoutMs)
        : null;
      repos.push({
        id: repo.id,
        file: repo.file,
        enabled: repo.enabled,
        cdsHost: hp.host,
        cdsPort: hp.port,
        clientCertPath: repo.sslclientcert || null,
        clientCert: repo.sslclientcert ? clientCertResults[repo.sslclientcert] : null,
        liveFetch,
        freshness,
      });
    }

    // Restricted to primary (non-debug, non-source) repos to keep this a
    // quick connectivity check rather than a full metadata download of
    // every variant of every repo.
    const primaryRepoIds = repos
      .filter((r) => !r.error && !/-(debug|source)-rpms$/.test(r.id))
      .map((r) => r.id);

    const subscriptionManager = await checkSubscriptionManager(conn, hostCfg, cfg.sshTimeoutMs);
    const liveUpdateCheck = await checkLiveUpdateCheck(
      conn,
      hostCfg,
      primaryRepoIds.length ? primaryRepoIds : repos.filter((r) => !r.error).map((r) => r.id),
      cfg.sshTimeoutMs
    );

    return {
      ...base,
      configured: true,
      connectivity,
      osRelease,
      serverSide: { servers: serverChecks },
      clientSide: {
        repos,
        subscriptionManager,
        liveUpdateCheck,
        issues: buildIssues(repos),
      },
      checkedAt: new Date(),
    };
  } catch (err) {
    return { ...base, configured: true, connectivity, error: err.message, checkedAt: new Date() };
  } finally {
    if (conn) conn.end();
  }
}

async function checkAll(cfg) {
  const host = await checkHost(cfg.host, cfg);
  return { generatedAt: new Date(), host };
}

// Remediation: enable RHUI repos that are currently disabled in the client's
// config. Requires root, or passwordless sudo for the configured SSH user.
async function enableRepos(hostCfg, repoIds, timeoutMs) {
  if (!repoIds || !repoIds.length) {
    throw new Error('No repo IDs given to enable');
  }
  const conn = await ssh.connect(hostCfg, timeoutMs);
  try {
    const cmd = withSudo(hostCfg, `dnf config-manager --set-enabled ${repoIds.join(' ')} 2>&1; echo __EXIT__:$?`);
    const { stdout } = await ssh.exec(conn, cmd, timeoutMs);
    const m = stdout.match(/__EXIT__:(\d+)/);
    const exitCode = m ? parseInt(m[1], 10) : null;
    const output = stdout.replace(/__EXIT__:\d+\s*$/, '').trim();
    return { success: exitCode === 0, exitCode, output };
  } finally {
    conn.end();
  }
}

module.exports = { checkAll, checkHost, enableRepos };
