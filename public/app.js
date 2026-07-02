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
  if (map.RHUI_SERVICES !== undefined) payload.services = map.RHUI_SERVICES;
  if (map.RHUI_DATA_PATH !== undefined) payload.dataPath = map.RHUI_DATA_PATH;
  if (map.RHUI_ENTITLEMENT_CERT_PATH !== undefined) payload.certPath = map.RHUI_ENTITLEMENT_CERT_PATH;
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

function renderServices(services) {
  if (!services || !services.length) return '<p class="muted">No services configured</p>';
  const rows = services
    .map((s) => `<tr><td>${s.service}</td><td>${badge(s.state, s.healthy ? 'ok' : 'bad')}</td></tr>`)
    .join('');
  return `<table><thead><tr><th>Service</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDisk(disk) {
  if (!disk) return '<p class="muted">No data</p>';
  if (disk.error) return `<p class="error-text">${disk.error}</p>`;
  return `<table>
    <tr><td>Path</td><td>${disk.path}</td></tr>
    <tr><td>Filesystem size</td><td>${disk.size || '—'}</td></tr>
    <tr><td>Used / Available</td><td>${disk.used || '—'} / ${disk.available || '—'} (${disk.usePercent || '—'})</td></tr>
    <tr><td>Data on disk</td><td>${disk.dataSize || '—'}</td></tr>
  </table>`;
}

function renderCert(cert) {
  if (!cert) return '<p class="muted">No data</p>';
  if (!cert.found) return `<p class="muted">Certificate not found at ${cert.path}</p>`;
  const level = cert.daysRemaining < 14 ? 'bad' : cert.daysRemaining < 30 ? 'warn' : 'ok';
  return `<table>
    <tr><td>Expires</td><td>${fmtDate(cert.expiresAt)}</td></tr>
    <tr><td>Days remaining</td><td>${badge(cert.daysRemaining, level)}</td></tr>
  </table>`;
}

function renderRepoFreshness(repos) {
  if (!repos || !repos.length) return '<p class="muted">No monitored repos configured</p>';
  const rows = repos
    .map((r) => {
      if (r.error) return `<tr class="repo-row error"><td>${r.repoId}</td><td colspan="3">${r.error}</td></tr>`;
      const cls = r.inSync === true ? 'in-sync' : r.inSync === false ? 'out-of-sync' : '';
      const lag = r.lagSeconds != null ? `${Math.round(r.lagSeconds / 3600)}h behind CDN` : (r.publicError || '—');
      return `<tr class="repo-row ${cls}">
        <td>${r.repoId}</td>
        <td>${fmtDate(r.localRevision)}</td>
        <td>${fmtDate(r.publicRevision)}</td>
        <td>${lag}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th>Repo</th><th>Local sync</th><th>Public CDN</th><th>Lag</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderHostCard(host) {
  if (!host.configured) {
    return `<div class="card">
      <h2>${host.label} ${badge('Not configured', 'muted')}</h2>
      <p class="muted">Add connection details via the Configuration form.</p>
    </div>`;
  }

  const reachable = host.connectivity && host.connectivity.reachable;
  const statusBadge = reachable ? badge('Online', 'ok') : badge('Unreachable', 'bad');

  if (!reachable) {
    return `<div class="card">
      <h2>${host.label} ${statusBadge}</h2>
      <div class="subtitle">${host.host}</div>
      <p class="error-text">${(host.connectivity && host.connectivity.error) || host.error || 'Unknown error'}</p>
    </div>`;
  }

  return `<div class="card">
    <h2>${host.label} ${statusBadge}</h2>
    <div class="subtitle">${host.host} · ${host.osRelease || ''} · latency ${host.connectivity.latencyMs}ms</div>

    <div class="section-title">Services</div>
    ${renderServices(host.services)}

    <div class="section-title">Data / Disk availability</div>
    ${renderDisk(host.disk)}

    <div class="section-title">Update freshness vs public Red Hat CDN</div>
    ${renderRepoFreshness(host.repoFreshness)}

    <div class="section-title">Entitlement certificate</div>
    ${renderCert(host.cert)}

    <div class="section-title">Uptime</div>
    <p class="muted">${host.uptime || '—'}</p>
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

async function init() {
  show(els.loading);
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
