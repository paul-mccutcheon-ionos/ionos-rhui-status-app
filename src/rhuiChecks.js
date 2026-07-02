const axios = require('axios');
const ssh = require('./sshService');

// IMPORTANT ARCHITECTURE NOTE
// We do not have access to the IONOS RHUI servers themselves. The RHEL 8/9
// hosts configured in this app are RHUI *clients* -- ordinary customer VMs
// that pull updates from IONOS's internal RHUI infrastructure. Every check
// below runs commands on that client (over SSH) to reproduce exactly what a
// real customer's `yum`/`dnf` sees: the repo config it was given, whether it
// can resolve/reach the RHUI server, whether the certificates involved are
// still valid, and whether a real metadata fetch / update check succeeds.
// We never connect to the RHUI servers directly from this app.

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
// id or baseurl mentions the RHUI filter string. This is exactly the config
// yum/dnf itself would use -- we are not guessing paths, we are reading the
// real repo definitions the client was provisioned with.
function parseRepoFiles(rawText, filter) {
  const repos = [];
  const fileBlocks = rawText.split(/^==>\s*(.+?)\s*<==$/m);
  // fileBlocks alternates [preamble, filename, content, filename, content, ...]
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
      if (!baseurl) continue;
      const haystack = `${id} ${baseurl}`.toLowerCase();
      if (filter && !haystack.includes(filter.toLowerCase())) continue;
      repos.push({
        id,
        file,
        baseurl,
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

function hostAndPortFromUrl(baseurl) {
  try {
    const u = new URL(baseurl);
    return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80, protocol: u.protocol };
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

// Fetches the RHUI server's TLS certificate exactly as the client sees it --
// including the private CA chain the client trusts -- by running the TLS
// handshake ON the client, not from this app server (which typically has no
// network path to IONOS's private RHUI network at all).
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
async function checkClientCertificate(conn, certPath, timeoutMs) {
  if (!certPath) {
    return { path: null, found: false, error: 'Repo file does not reference a client (sslclientcert) certificate' };
  }
  try {
    const { stdout, code } = await ssh.exec(conn, `openssl x509 -enddate -subject -noout -in ${certPath} 2>&1`, timeoutMs);
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

// Actually fetches repodata/repomd.xml from the RHUI server through the same
// path (and client certificate, if configured) yum/dnf would use. Success
// here means the client can genuinely pull metadata right now.
async function checkLiveMetadataFetch(conn, repo, timeoutMs) {
  const certArgs = [];
  if (repo.sslcacert) certArgs.push(`--cacert ${repo.sslcacert}`);
  if (repo.sslclientcert && repo.sslclientkey) certArgs.push(`--cert ${repo.sslclientcert} --key ${repo.sslclientkey}`);
  if (repo.sslverify === '0' || (repo.sslverify || '').toLowerCase() === 'no') certArgs.push('-k');

  const url = `${repo.baseurl.replace(/\/+$/, '')}/repodata/repomd.xml`;
  const marker = '__HTTP_CODE__:';
  const cmd = `curl -s --connect-timeout 10 -m 20 ${certArgs.join(' ')} -w '\\n${marker}%{http_code}' "${url}" 2>&1`;

  try {
    const { stdout } = await ssh.exec(conn, cmd, timeoutMs);
    const idx = stdout.lastIndexOf(marker);
    if (idx === -1) {
      return { url, success: false, error: stdout.trim() || 'curl produced no output (connection likely failed)' };
    }
    const body = stdout.slice(0, idx).trim();
    const httpCode = stdout.slice(idx + marker.length).trim();
    if (httpCode !== '200') {
      return { url, success: false, httpCode, error: `HTTP ${httpCode}` };
    }
    return { url, success: true, httpCode, localRevision: parseRepomdRevision(body) };
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
// discovered RHUI repos, restricted to just those repos. This is exactly
// what runs on the customer's box during a real `dnf update`.
async function checkLiveUpdateCheck(conn, repoIds, timeoutMs) {
  if (!repoIds.length) {
    return { ran: false, reason: 'No RHUI repos discovered to test' };
  }
  const enable = repoIds.map((id) => `--enablerepo=${id}`).join(' ');
  const cmd = `timeout 45 dnf --disablerepo='*' ${enable} check-update 2>&1; echo __EXIT__:$?`;
  try {
    const { stdout } = await ssh.exec(conn, cmd, timeoutMs + 45000);
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

async function checkHost(hostKey, hostCfg, cfg) {
  const base = { hostKey, label: hostCfg.label, host: hostCfg.host };

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
    const discovered = await discoverRhuiRepos(conn, cfg.repoFilter, cfg.sshTimeoutMs);

    const repos = [];
    for (const repo of discovered) {
      const hp = hostAndPortFromUrl(repo.baseurl);
      if (!hp) {
        repos.push({ ...repo, error: `Could not parse baseurl: ${repo.baseurl}` });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const [dns, serverCert, clientCert, liveFetch] = await Promise.all([
        checkDnsResolution(conn, hp.host, cfg.sshTimeoutMs),
        checkServerCertificate(conn, hp.host, hp.port, cfg.sshTimeoutMs),
        checkClientCertificate(conn, repo.sslclientcert, cfg.sshTimeoutMs),
        checkLiveMetadataFetch(conn, repo, cfg.sshTimeoutMs),
      ]);

      // eslint-disable-next-line no-await-in-loop
      const freshness = liveFetch.success
        ? await checkFreshnessVsPublicCdn(liveFetch.localRevision, repo.id, cfg.monitoredRepos, cfg.cdnTimeoutMs)
        : null;

      repos.push({
        id: repo.id,
        file: repo.file,
        baseurl: repo.baseurl,
        enabled: repo.enabled,
        cdsHost: hp.host,
        cdsPort: hp.port,
        dns,
        serverCert,
        clientCert,
        liveFetch,
        freshness,
      });
    }

    const liveUpdateCheck = await checkLiveUpdateCheck(
      conn,
      repos.filter((r) => r.enabled).map((r) => r.id),
      cfg.sshTimeoutMs
    );

    return {
      ...base,
      configured: true,
      connectivity,
      osRelease,
      repos,
      liveUpdateCheck,
      checkedAt: new Date(),
    };
  } catch (err) {
    return { ...base, configured: true, connectivity, error: err.message, checkedAt: new Date() };
  } finally {
    if (conn) conn.end();
  }
}

async function checkAll(cfg) {
  const [rhel8, rhel9] = await Promise.all([
    checkHost('rhel8', cfg.hosts.rhel8, cfg),
    checkHost('rhel9', cfg.hosts.rhel9, cfg),
  ]);
  return { generatedAt: new Date(), hosts: { rhel8, rhel9 } };
}

module.exports = { checkAll, checkHost };
