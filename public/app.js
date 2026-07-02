const els = {
  loading: document.getElementById('loading-view'),
  setup: document.getElementById('setup-view'),
  dashboard: document.getElementById('dashboard-view'),
  hostCards: document.getElementById('host-cards'),
  lastUpdated: document.getElementById('last-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  setupBtn: document.getElementById('setup-btn'),
  setupForm: document.getElementById('setup-form'),
  setupStatus: document.getElementById('setup-status'),
  saveEnvBtn: document.getElementById('save-env-btn'),
  envUpload: document.getElementById('env-upload'),
  versionPill: document.getElementById('version-pill'),
};

const ENV_FIELD_MAP = {
  LABEL: 'label',
  HOST: 'host',
  SSH_PORT: 'port',
  SSH_USER: 'username',
  SSH_KEY_PATH: 'keyPath',
  SSH_KEY_CONTENT: 'keyContent',
  SSH_PASSPHRASE: 'passphrase',
};

function parseEnvText(text) {
  const map = {};
  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map[key] = value;
  });
  return map;
}

function envMapToPayload(map) {
  const payload = { host: {} };
  for (const [suffix, field] of Object.entries(ENV_FIELD_MAP)) {
    const envKey = `HOST_${suffix}`;
    if (map[envKey] !== undefined) payload.host[field] = map[envKey];
  }
  if (map.RHUI_REPO_FILTER !== undefined) payload.repoFilter = map.RHUI_REPO_FILTER;
  if (map.RHUI_MONITORED_REPOS !== undefined) payload.monitoredRepos = map.RHUI_MONITORED_REPOS;
  return payload;
}

let pollTimer = null;

function show(view) {
  els.loading.classList.add('hidden');
  els.setup.classList.add('hidden');
  els.dashboard.classList.add('hidden');
  view.classList.remove('hidden');
}

function badge(text, level) {
  return `<span class="badge badge-${level}">${text}</span>`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString();
}

function renderDns(dns) {
  if (!dns) return '<p class="muted">No data</p>';
  if (!dns.resolved) return `<p class="error-text">Could not resolve ${dns.host}: ${dns.error}</p>`;
  return `<p>${dns.host} → <strong>${dns.ip}</strong> ${badge('Resolved', 'ok')}</p>`;
}

function renderServerCert(cert) {
  if (!cert) return '<p class="muted">No data</p>';
  if (!cert.found) return `<p class="error-text">${cert.error || 'Could not retrieve certificate'}</p>`;
  const level = cert.expired ? 'bad' : cert.daysRemaining < 30 ? 'warn' : 'ok';
  return `<table>
    <tr><td>Subject</td><td>${cert.subject || '—'}</td></tr>
    <tr><td>Issuer</td><td>${cert.issuer || '—'}</td></tr>
    <tr><td>Valid</td><td>${fmtDate(cert.notBefore)} → ${fmtDate(cert.notAfter)}</td></tr>
    <tr><td>Days remaining</td><td>${badge(cert.expired ? 'EXPIRED' : cert.daysRemaining, level)}</td></tr>
  </table>`;
}

function renderClientCert(cert) {
  if (!cert) return '<p class="muted">No data</p>';
  if (!cert.found) return `<p class="muted">${cert.error || 'No client certificate configured for this repo'}</p>`;
  const level = cert.expired ? 'bad' : cert.daysRemaining < 30 ? 'warn' : 'ok';
  return `<table>
    <tr><td>Path</td><td>${cert.path}</td></tr>
    <tr><td>Subject</td><td>${cert.subject || '—'}</td></tr>
    <tr><td>Expires</td><td>${fmtDate(cert.notAfter)}</td></tr>
    <tr><td>Days remaining</td><td>${badge(cert.expired ? 'EXPIRED' : cert.daysRemaining, level)}</td></tr>
  </table>`;
}

function renderLiveFetch(fetchResult) {
  if (!fetchResult) return '<p class="muted">No data</p>';
  if (!fetchResult.success) return `<p class="error-text">Failed: ${fetchResult.error || 'unknown error'}</p>`;
  return `<p>${badge('Success (HTTP 200)', 'ok')} — metadata revision ${fmtDate(fetchResult.localRevision)}</p>`;
}

function renderFreshness(freshness) {
  if (!freshness) return '<p class="muted">No public CDN comparison configured for this repo</p>';
  if (freshness.error) return `<p class="error-text">${freshness.error}</p>`;
  const lag = freshness.lagSeconds != null ? Math.round(freshness.lagSeconds / 3600) : null;
  const level = freshness.inSync ? 'ok' : lag != null && lag > 48 ? 'warn' : 'ok';
  return `<p>Public CDN revision ${fmtDate(freshness.publicRevision)} — ${
    lag != null ? badge(`${lag}h behind CDN`, level) : badge('unknown lag', 'muted')
  }</p>`;
}

function renderPing(ping) {
  if (!ping) return '<p class="muted">No data</p>';
  if (ping.error) return `<p class="muted">${ping.error}</p>`;
  if (!ping.responded) return `<p class="muted">${badge('No response', 'muted')} ${ping.note || ''}</p>`;
  return `<p>${badge('Responds to ping', 'ok')} avg ${ping.avgRttMs}ms</p>`;
}

function renderServerBlock(server) {
  return `<div class="repo-block">
    <h3>${server.host}:${server.port}</h3>

    <p class="check-explainer">DNS — can the client resolve the RHUI server's hostname?</p>
    ${renderDns(server.dns)}

    <p class="check-explainer">Ping — basic ICMP reachability. Informational only: many firewalls block ICMP even when the actual service works fine.</p>
    ${renderPing(server.ping)}

    <p class="check-explainer">Server certificate — the TLS certificate this RHUI server presents to the client. If expired or untrusted, updates fail with SSL errors.</p>
    ${renderServerCert(server.cert)}
  </div>`;
}

function renderRepoRow(repo) {
  if (repo.error) {
    return `<tr><td>${repo.id}</td><td colspan="4" class="error-text">${repo.error}</td></tr>`;
  }
  const fetchOk = repo.liveFetch && repo.liveFetch.success;
  const fetchCell = fetchOk
    ? badge('OK', 'ok')
    : badge(repo.liveFetch ? repo.liveFetch.error || 'Failed' : 'No data', 'bad');
  const lag = repo.freshness && repo.freshness.lagSeconds != null ? `${Math.round(repo.freshness.lagSeconds / 3600)}h` : '—';
  return `<tr>
    <td>${repo.id}</td>
    <td>${repo.enabled ? badge('enabled', 'ok') : badge('disabled', 'warn')}</td>
    <td>${fetchCell}</td>
    <td>${lag}</td>
  </tr>`;
}

function renderClientCertSummary(repos) {
  const seen = new Map();
  for (const repo of repos) {
    if (repo.clientCertPath && !seen.has(repo.clientCertPath)) seen.set(repo.clientCertPath, repo.clientCert);
  }
  if (!seen.size) return '<p class="muted">No client certificate referenced by any discovered repo</p>';
  return [...seen.entries()].map(([, cert]) => renderClientCert(cert)).join('');
}

function renderSubscriptionManager(sm) {
  if (!sm) return '<p class="muted">No data</p>';
  if (!sm.ran) return `<p class="error-text">Could not run subscription-manager: ${sm.error}</p>`;
  if (sm.expectedForRhui) {
    return `<p>${badge(sm.overallStatus || 'Unknown/unregistered', 'ok')} — this is the <strong>correct</strong> state for an IONOS RHUI-managed host. It should NOT be registered directly with Red Hat.</p>`;
  }
  return `<p>${badge(sm.overallStatus || 'Registered', 'warn')} — this host appears to be registered directly with Red Hat as well as using IONOS RHUI. Check for accidental double-billing.</p>`;
}

function renderIssues(issues) {
  if (!issues || !issues.length) return '<p class="muted">No configuration issues detected.</p>';
  return issues
    .map(
      (issue) => `<div class="repo-block">
        <p>${badge(issue.severity === 'warning' ? 'Issue' : 'Error', issue.severity === 'warning' ? 'warn' : 'bad')} ${issue.message}</p>
        ${
          issue.fixId
            ? `<p class="muted">Fix command: <code>${issue.fixCommand}</code></p>
               <button class="btn fix-btn" data-fix-id="${issue.fixId}" data-repo-ids='${JSON.stringify(issue.repoIds)}'>${issue.fixLabel}</button>`
            : ''
        }
      </div>`
    )
    .join('');
}

function renderLiveUpdateCheck(check) {
  if (!check) return '<p class="muted">No data</p>';
  if (!check.ran) return `<p class="muted">${check.reason || 'Not run'}</p>`;
  if (check.error) return `<p class="error-text">${check.error}</p>`;
  const statusBadge = check.success
    ? check.updatesAvailable
      ? badge('Updates available', 'ok')
      : badge('Up to date', 'ok')
    : badge(`Failed (exit ${check.exitCode})`, 'bad');
  return `<div>
    <p>${statusBadge}</p>
    <pre class="output-block">${(check.output || '').replace(/</g, '&lt;')}</pre>
  </div>`;
}

function renderHostCard(host) {
  if (!host.configured) {
    return `<div class="card">
      <h2>${host.label} ${badge('Not configured', 'muted')}</h2>
      <p class="muted">Add connection details via the Configuration form.</p>
    </div>`;
  }

  const reachable = host.connectivity && host.connectivity.reachable;
  const statusBadge = reachable ? badge('Diagnostics OK', 'ok') : badge('Unreachable', 'bad');

  if (!reachable) {
    return `<div class="card">
      <h2>${host.label} ${statusBadge}</h2>
      <div class="subtitle">${host.host}</div>
      <p class="check-explainer">This app could not SSH into the test client itself to run diagnostics — this is a problem with the test client, not necessarily with RHUI.</p>
      <p class="error-text">${(host.connectivity && host.connectivity.error) || host.error || 'Unknown error'}</p>
    </div>`;
  }

  if (host.error) {
    return `<div class="card">
      <h2>${host.label} ${badge('Error', 'bad')}</h2>
      <div class="subtitle">${host.host} · ${host.osRelease || ''}</div>
      <p class="error-text">${host.error}</p>
    </div>`;
  }

  const repos = host.clientSide && host.clientSide.repos;
  if (!repos || !repos.length) {
    return `<div class="card">
      <h2>${host.label} ${statusBadge}</h2>
      <div class="subtitle">${host.host} · ${host.osRelease || ''}</div>
      <p class="muted">No RHUI repos were found in /etc/yum.repos.d matching the configured filter. Check the "Repo filter" setting or verify this client is actually registered with RHUI.</p>
    </div>`;
  }

  const servers = (host.serverSide && host.serverSide.servers) || [];
  const serverBlocks = servers.map(renderServerBlock).join('');

  const repoRows = repos.map(renderRepoRow).join('');

  return `<div class="card">
    <h2>${host.label} ${statusBadge}</h2>
    <div class="subtitle">${host.host} · ${host.osRelease || ''} · SSH latency ${host.connectivity.latencyMs}ms</div>

    <div class="section-title">RHUI server-side (as seen by this client)</div>
    <p class="check-explainer">The basics: is the RHUI server itself reachable and does it present a valid certificate? This app has no direct access to RHUI, so these checks run from the client.</p>
    ${serverBlocks}

    <div class="section-title">Configuration issues found on this client</div>
    ${renderIssues(host.clientSide.issues)}

    <div class="section-title">Client entitlement certificate</div>
    <p class="check-explainer">The certificate this client uses to authenticate to RHUI. This is the one that most often expires and silently breaks updates.</p>
    ${renderClientCertSummary(repos)}

    <div class="section-title">Subscription Manager status</div>
    <p class="check-explainer">On an IONOS RHUI-managed host, this should show "Unknown" / not registered — that's correct, not an error.</p>
    ${renderSubscriptionManager(host.clientSide.subscriptionManager)}

    <div class="section-title">RHUI repositories configured on this client</div>
    <p class="check-explainer">Every RHUI repo found in this client's own config, whether it's currently enabled, and whether this app could actually fetch its metadata just now.</p>
    <table>
      <thead><tr><th>Repo</th><th>Enabled</th><th>Live fetch</th><th>Lag vs public CDN</th></tr></thead>
      <tbody>${repoRows}</tbody>
    </table>

    <div class="section-title">Live update check (dnf check-update)</div>
    <p class="check-explainer">The ground-truth test: actually asking dnf to refresh metadata for the primary RHUI repos. This is exactly what runs during a real "dnf update". Debug/source repo variants are skipped here to keep this fast.</p>
    ${renderLiveUpdateCheck(host.clientSide.liveUpdateCheck)}
  </div>`;
}

async function loadStatus(force) {
  try {
    const resp = await fetch(`/api/status${force ? '?refresh=true' : ''}`);
    if (resp.status === 409) {
      show(els.setup);
      return;
    }
    const data = await resp.json();
    els.hostCards.innerHTML = renderHostCard(data.host);
    els.lastUpdated.textContent = `Updated ${fmtDate(data.generatedAt)}`;
    show(els.dashboard);
  } catch (err) {
    els.hostCards.innerHTML = `<p class="error-text">Failed to load status: ${err.message}</p>`;
    show(els.dashboard);
  }
}

function hostIsFilled(h) {
  return Boolean(h && h.host && h.username && (h.keyPath || h.keyContent));
}

function formToConfigPayload(form) {
  const data = new FormData(form);
  const payload = { host: {} };
  for (const [key, value] of data.entries()) {
    if (key.startsWith('host.')) payload.host[key.slice(5)] = value;
    else payload[key] = value;
  }
  return payload;
}

async function loadVersion() {
  try {
    const resp = await fetch('/api/version');
    const { version } = await resp.json();
    els.versionPill.textContent = `v${version}`;
  } catch (err) {
    els.versionPill.textContent = '';
  }
}

async function init() {
  show(els.loading);
  loadVersion();
  const statusResp = await fetch('/api/config/status');
  const { configured } = await statusResp.json();

  if (configured) {
    await loadStatus(false);
    pollTimer = setInterval(() => loadStatus(false), 60000);
  } else {
    show(els.setup);
  }
}

els.refreshBtn.addEventListener('click', () => loadStatus(true));

els.hostCards.addEventListener('click', async (e) => {
  const btn = e.target.closest('.fix-btn');
  if (!btn) return;
  const fixId = btn.dataset.fixId;
  const repoIds = JSON.parse(btn.dataset.repoIds || '[]');
  btn.disabled = true;
  btn.textContent = 'Applying fix…';
  try {
    const resp = await fetch(`/api/fix/${fixId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoIds }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || result.output || 'Fix failed');
    await loadStatus(true);
  } catch (err) {
    btn.textContent = `Failed: ${err.message}`;
    btn.disabled = false;
  }
});

els.setupBtn.addEventListener('click', () => {
  if (pollTimer) clearInterval(pollTimer);
  show(els.setup);
});

els.setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToConfigPayload(els.setupForm);
  if (!hostIsFilled(payload.host)) {
    els.setupStatus.textContent = 'Error: fill in host, SSH user, and a key (path or content) for the test client.';
    return;
  }
  els.setupStatus.textContent = 'Applying…';
  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Failed to apply configuration');
    els.setupStatus.textContent = 'Configuration applied. Loading status…';
    await loadStatus(true);
    pollTimer = setInterval(() => loadStatus(false), 60000);
  } catch (err) {
    els.setupStatus.textContent = `Error: ${err.message}`;
  }
});

els.saveEnvBtn.addEventListener('click', async () => {
  const payload = formToConfigPayload(els.setupForm);
  if (!hostIsFilled(payload.host)) {
    els.setupStatus.textContent = 'Error: fill in host, SSH user, and a key (path or content) for the test client.';
    return;
  }
  els.setupStatus.textContent = 'Saving to .env…';
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const resp = await fetch('/api/config/save', { method: 'POST' });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Failed to save');
    els.setupStatus.textContent = `Saved to ${result.savedTo}`;
  } catch (err) {
    els.setupStatus.textContent = `Error: ${err.message}`;
  }
});

els.envUpload.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  show(els.setup);
  els.setupStatus.textContent = `Applying ${file.name}…`;
  try {
    const text = await file.text();
    const payload = envMapToPayload(parseEnvText(text));
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Failed to apply uploaded .env');
    els.setupStatus.textContent = 'Configuration applied from upload. Loading status…';
    await loadStatus(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => loadStatus(false), 60000);
  } catch (err) {
    els.setupStatus.textContent = `Error: ${err.message}`;
  } finally {
    e.target.value = '';
  }
});

init();
