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
  const payload = { rhel8: {}, rhel9: {} };
  for (const prefix of ['RHEL8', 'RHEL9']) {
    const key = prefix.toLowerCase();
    for (const [suffix, field] of Object.entries(ENV_FIELD_MAP)) {
      const envKey = `${prefix}_${suffix}`;
      if (map[envKey] !== undefined) payload[key][field] = map[envKey];
    }
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

function renderRepoBlock(repo) {
  if (repo.error) {
    return `<div class="repo-block"><h3>${repo.id}</h3><p class="error-text">${repo.error}</p></div>`;
  }
  return `<div class="repo-block">
    <h3>${repo.id} ${repo.enabled ? '' : badge('disabled', 'muted')}</h3>
    <p class="muted">RHUI server: ${repo.cdsHost}:${repo.cdsPort} · defined in ${repo.file}</p>

    <p class="check-explainer">DNS — can the client resolve the RHUI server's hostname?</p>
    ${renderDns(repo.dns)}

    <p class="check-explainer">Server certificate — the TLS certificate this RHUI server presents to the client. If expired or untrusted, updates fail with SSL errors.</p>
    ${renderServerCert(repo.serverCert)}

    <p class="check-explainer">Client entitlement certificate — the certificate this client uses to authenticate to RHUI. This is the one that most often expires and silently breaks updates.</p>
    ${renderClientCert(repo.clientCert)}

    <p class="check-explainer">Live metadata fetch — actually downloading this repo's metadata the same way yum/dnf would, using the same certificates.</p>
    ${renderLiveFetch(repo.liveFetch)}

    <p class="check-explainer">Freshness vs public Red Hat CDN — how far behind the public Red Hat mirrors this RHUI repo is. Some lag is normal; large or growing lag suggests a sync problem on IONOS's side.</p>
    ${renderFreshness(repo.freshness)}
  </div>`;
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

  const repoBlocks = host.repos && host.repos.length
    ? host.repos.map(renderRepoBlock).join('')
    : `<p class="muted">No RHUI repos were found in /etc/yum.repos.d matching the configured filter. Check the "Repo filter" setting or verify this client is actually registered with RHUI.</p>`;

  return `<div class="card">
    <h2>${host.label} ${statusBadge}</h2>
    <div class="subtitle">${host.host} · ${host.osRelease || ''} · SSH latency ${host.connectivity.latencyMs}ms</div>

    <div class="section-title">RHUI repositories detected on this client</div>
    <p class="check-explainer">Each block below is one RHUI repo this client is configured to use, checked exactly as yum/dnf would use it.</p>
    ${repoBlocks}

    <div class="section-title">Live update check (dnf check-update)</div>
    <p class="check-explainer">The ground-truth test: actually asking dnf to refresh metadata for these RHUI repos, restricted to just them. This is exactly what runs during a real "dnf update".</p>
    ${renderLiveUpdateCheck(host.liveUpdateCheck)}
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
    els.hostCards.innerHTML = renderHostCard(data.hosts.rhel8) + renderHostCard(data.hosts.rhel9);
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
  const payload = { rhel8: {}, rhel9: {} };
  for (const [key, value] of data.entries()) {
    if (key.startsWith('rhel8.')) payload.rhel8[key.slice(6)] = value;
    else if (key.startsWith('rhel9.')) payload.rhel9[key.slice(6)] = value;
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

els.setupBtn.addEventListener('click', () => {
  if (pollTimer) clearInterval(pollTimer);
  show(els.setup);
});

els.setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToConfigPayload(els.setupForm);
  if (!hostIsFilled(payload.rhel8) && !hostIsFilled(payload.rhel9)) {
    els.setupStatus.textContent = 'Error: fill in host, SSH user, and a key (path or content) for at least one host (RHEL 8 or RHEL 9).';
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
  if (!hostIsFilled(payload.rhel8) && !hostIsFilled(payload.rhel9)) {
    els.setupStatus.textContent = 'Error: fill in host, SSH user, and a key (path or content) for at least one host (RHEL 8 or RHEL 9).';
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
