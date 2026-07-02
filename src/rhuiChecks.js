const axios = require('axios');
const tls = require('tls');
const ssh = require('./sshService');

function parseRepomdRevision(xml) {
  if (!xml) return null;
  const match = xml.match(/<revision>(\d+)<\/revision>/);
  if (!match) return null;
  const epoch = parseInt(match[1], 10);
  if (Number.isNaN(epoch)) return null;
  return new Date(epoch * 1000);
}

async function checkConnectivity(hostCfg, timeoutMs) {
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

async function checkOsRelease(conn, timeoutMs) {
  const { stdout } = await ssh.exec(conn, 'cat /etc/redhat-release 2>/dev/null', timeoutMs);
  return stdout.trim() || 'unknown';
}

async function checkServices(conn, services, timeoutMs) {
  if (!services.length) return [];
  const results = [];
  for (const service of services) {
    try {
      const { stdout } = await ssh.exec(conn, `systemctl is-active ${service} 2>/dev/null`, timeoutMs);
      const state = stdout.trim() || 'unknown';
      results.push({ service, state, healthy: state === 'active' });
    } catch (err) {
      results.push({ service, state: 'error', healthy: false, error: err.message });
    }
  }
  return results;
}

async function checkDisk(conn, dataPath, timeoutMs) {
  try {
    const { stdout } = await ssh.exec(
      conn,
      `df -hP ${dataPath} 2>/dev/null | tail -1 && echo '---' && du -sh ${dataPath} 2>/dev/null`,
      timeoutMs
    );
    const [dfLine, , duLine] = stdout.split('\n');
    const dfParts = (dfLine || '').trim().split(/\s+/);
    const [filesystem, size, used, avail, usePercent, mountedOn] = dfParts;
    const dataSize = (duLine || '').trim().split(/\s+/)[0];
    return {
      path: dataPath,
      filesystem,
      size,
      used,
      available: avail,
      usePercent,
      mountedOn,
      dataSize: dataSize || null,
    };
  } catch (err) {
    return { path: dataPath, error: err.message };
  }
}

async function checkUptimeAndLoad(conn, timeoutMs) {
  try {
    const { stdout } = await ssh.exec(conn, 'uptime 2>/dev/null', timeoutMs);
    return stdout.trim();
  } catch (err) {
    return null;
  }
}

async function checkCertExpiry(conn, certPath, timeoutMs) {
  try {
    const { stdout, code } = await ssh.exec(
      conn,
      `openssl x509 -enddate -noout -in ${certPath} 2>/dev/null`,
      timeoutMs
    );
    if (code !== 0 || !stdout.includes('notAfter=')) {
      return { path: certPath, found: false };
    }
    const dateStr = stdout.trim().replace('notAfter=', '');
    const expiresAt = new Date(dateStr);
    const daysRemaining = Math.round((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return { path: certPath, found: true, expiresAt, daysRemaining };
  } catch (err) {
    return { path: certPath, found: false, error: err.message };
  }
}

// Connects over TLS the same way an RHEL client's yum/dnf does when it hits
// the RHUI content server, so the certificate seen (and its expiry) matches
// what actually breaks client updates -- independent of SSH/management access.
async function checkClientTlsCertificate(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const result = { host, port };
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, ...extra });
    };

    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !Object.keys(cert).length) {
          socket.end();
          finish({ error: 'Server did not present a certificate' });
          return;
        }
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const daysRemaining = Math.round((validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        finish({
          subject: (cert.subject && (cert.subject.CN || JSON.stringify(cert.subject))) || null,
          issuer: (cert.issuer && (cert.issuer.CN || JSON.stringify(cert.issuer))) || null,
          validFrom,
          validTo,
          daysRemaining,
          expired: daysRemaining < 0,
          trusted: socket.authorized,
          trustError: socket.authorized ? null : socket.authorizationError,
        });
        socket.end();
      }
    );

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      finish({ error: `TLS connection timed out after ${timeoutMs}ms` });
    });

    socket.on('error', (err) => {
      finish({ error: err.message });
    });
  });
}

async function fetchPublicRepomd(url, timeoutMs) {
  const resp = await axios.get(url, { timeout: timeoutMs, responseType: 'text', transformResponse: [(d) => d] });
  return resp.data;
}

async function checkRepoFreshness(conn, repo, timeoutMs) {
  const result = { repoId: repo.repoId, localPath: repo.localRepomdPath, publicUrl: repo.publicRepomdUrl };
  try {
    const { stdout, code } = await ssh.exec(conn, `cat ${repo.localRepomdPath} 2>/dev/null`, timeoutMs);
    if (code !== 0 || !stdout) {
      result.error = 'local repomd.xml not found or unreadable';
      return result;
    }
    result.localRevision = parseRepomdRevision(stdout);
  } catch (err) {
    result.error = `local read failed: ${err.message}`;
    return result;
  }

  try {
    const publicXml = await fetchPublicRepomd(repo.publicRepomdUrl, timeoutMs);
    result.publicRevision = parseRepomdRevision(publicXml);
  } catch (err) {
    result.publicError = `public CDN fetch failed: ${err.message}`;
  }

  if (result.localRevision && result.publicRevision) {
    result.lagSeconds = Math.round((result.publicRevision.getTime() - result.localRevision.getTime()) / 1000);
    result.inSync = result.lagSeconds <= 0;
  }

  return result;
}

async function checkHost(hostKey, hostCfg, cfg) {
  const base = { hostKey, label: hostCfg.label, host: hostCfg.host };

  if (!hostCfg.host || !hostCfg.username || (!hostCfg.keyPath && !hostCfg.keyContent)) {
    return { ...base, configured: false };
  }

  const [connectivity, clientTlsCert] = await Promise.all([
    checkConnectivity(hostCfg, cfg.sshTimeoutMs),
    checkClientTlsCertificate(hostCfg.host, cfg.clientTlsPort, cfg.sshTimeoutMs),
  ]);

  if (!connectivity.reachable) {
    return { ...base, configured: true, connectivity, clientTlsCert, checkedAt: new Date() };
  }

  let conn;
  try {
    conn = await ssh.connect(hostCfg, cfg.sshTimeoutMs);
    const [osRelease, services, disk, uptime, cert] = await Promise.all([
      checkOsRelease(conn, cfg.sshTimeoutMs),
      checkServices(conn, cfg.services, cfg.sshTimeoutMs),
      checkDisk(conn, cfg.dataPath, cfg.sshTimeoutMs),
      checkUptimeAndLoad(conn, cfg.sshTimeoutMs),
      checkCertExpiry(conn, cfg.certPath, cfg.sshTimeoutMs),
    ]);

    const relevantRepos = cfg.monitoredRepos.filter((r) => r.repoId.includes(hostKey === 'rhel8' ? '8' : '9'));
    const reposToCheck = relevantRepos.length ? relevantRepos : cfg.monitoredRepos;
    const repoFreshness = [];
    for (const repo of reposToCheck) {
      // eslint-disable-next-line no-await-in-loop
      repoFreshness.push(await checkRepoFreshness(conn, repo, cfg.cdnTimeoutMs));
    }

    return {
      ...base,
      configured: true,
      connectivity,
      osRelease,
      services,
      disk,
      uptime,
      cert,
      clientTlsCert,
      repoFreshness,
      checkedAt: new Date(),
    };
  } catch (err) {
    return { ...base, configured: true, connectivity, clientTlsCert, error: err.message, checkedAt: new Date() };
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
