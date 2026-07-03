const els = {
  loading: document.getElementById('loading-view'),
  setup: document.getElementById('setup-view'),
  dashboard: document.getElementById('dashboard-view'),
  hostSelectWrap: document.getElementById('host-select-wrap'),
  hostSelect: document.getElementById('host-select'),
  hostHeader: document.getElementById('host-header'),
  viewServer: document.getElementById('view-server'),
  viewClient: document.getElementById('view-client'),
  navItems: document.querySelectorAll('.nav-item'),
  lastUpdated: document.getElementById('last-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  setupBtn: document.getElementById('setup-btn'),
  setupForm: document.getElementById('setup-form'),
  setupStatus: document.getElementById('setup-status'),
  saveEnvBtn: document.getElementById('save-env-btn'),
  envUpload: document.getElementById('env-upload'),
  versionPill: document.getElementById('version-pill'),
  ionosApiToken: document.getElementById('ionos-api-token'),
  ionosContractNumber: document.getElementById('ionos-contract-number'),
  discoverBtn: document.getElementById('discover-btn'),
  discoverStatus: document.getElementById('discover-status'),
  discoverResults: document.getElementById('discover-results'),
  sameKeyToggle: document.getElementById('same-key-toggle'),
  sharedKeyFields: document.getElementById('shared-key-fields'),
  hostsList: document.getElementById('hosts-list'),
  addHostBtn: document.getElementById('add-host-btn'),
};

function escapeHtml(s) {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Setup form state: discovered IONOS servers + manually-added hosts.
// ---------------------------------------------------------------------------

let discoveredServers = [];
let manualHosts = [];

function sameKeyEnabled() {
  return els.sameKeyToggle.checked;
}

function renderPerHostKeyFields(values = {}) {
  const hiddenClass = sameKeyEnabled() ? 'hidden' : '';
  return `<div class="per-host-keys ${hiddenClass}">
    <label>SSH User <input data-field="username" value="${escapeHtml(values.username)}" placeholder="cloud-user" /></label>
    <label>SSH Port <input data-field="port" type="number" value="${escapeHtml(values.port || 22)}" /></label>
    <label>SSH Key Path <input data-field="keyPath" value="${escapeHtml(values.keyPath)}" /></label>
    <label>SSH Key Content <textarea data-field="keyContent" rows="2" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">${escapeHtml(values.keyContent)}</textarea></label>
    <label>Passphrase <input data-field="passphrase" type="password" value="${escapeHtml(values.passphrase)}" /></label>
  </div>`;
}

function renderDiscoverResults() {
  if (!discoveredServers.length) {
    els.discoverResults.innerHTML = '';
    return;
  }
  els.discoverResults.innerHTML = discoveredServers
    .map((server, index) => {
      const ip = (server.ips && server.ips[0]) || '';
      return `<div class="discover-row" data-discover-index="${index}">
        <input type="checkbox" class="discover-checkbox" />
        <div class="discover-row-main">
          <div class="name">${escapeHtml(server.name)} <span class="muted">(${escapeHtml(server.datacenterName)})</span></div>
          <div class="muted">Image: ${escapeHtml(server.image)}</div>
          <label>Label <input data-field="label" value="${escapeHtml(server.name)}" /></label>
          <label>Host / IP <input data-field="host" value="${escapeHtml(ip)}" placeholder="10.0.0.10" /></label>
          ${renderPerHostKeyFields()}
        </div>
      </div>`;
    })
    .join('');
}

function renderHostsList() {
  if (!manualHosts.length) {
    els.hostsList.innerHTML = '<p class="muted">No manually-added hosts.</p>';
    return;
  }
  els.hostsList.innerHTML = manualHosts
    .map(
      (host, index) => `<div class="host-row" data-host-index="${index}">
        <div class="host-row-main">
          <label>Label <input data-field="label" value="${escapeHtml(host.label)}" placeholder="Test client" /></label>
          <label>Host / IP <input data-field="host" value="${escapeHtml(host.host)}" placeholder="10.0.0.10" /></label>
          ${renderPerHostKeyFields(host)}
        </div>
        <button type="button" class="host-row-remove" data-remove-index="${index}">Remove</button>
      </div>`
    )
    .join('');
}

function toggleSameKeyVisibility() {
  const useShared = sameKeyEnabled();
  els.sharedKeyFields.style.display = useShared ? '' : 'none';
  document.querySelectorAll('.per-host-keys').forEach((el) => el.classList.toggle('hidden', useShared));
}

function collectHostsPayload() {
  const shared = {
    username: document.getElementById('shared-username').value,
    port: document.getElementById('shared-port').value,
    keyPath: document.getElementById('shared-keypath').value,
    keyContent: document.getElementById('shared-keycontent').value,
    passphrase: document.getElementById('shared-passphrase').value,
  };
  const useSame = sameKeyEnabled();
  const hosts = [];

  const readRow = (row) => {
    const get = (field) => row.querySelector(`[data-field="${field}"]`)?.value || '';
    const entry = useSame
      ? { ...shared }
      : {
          username: get('username'),
          port: get('port'),
          keyPath: get('keyPath'),
          keyContent: get('keyContent'),
          passphrase: get('passphrase'),
        };
    return { label: get('label'), host: get('host'), ...entry };
  };

  document.querySelectorAll('#discover-results .discover-row').forEach((row) => {
    const checkbox = row.querySelector('.discover-checkbox');
    if (checkbox && checkbox.checked) hosts.push(readRow(row));
  });

  document.querySelectorAll('#hosts-list .host-row').forEach((row) => {
    hosts.push(readRow(row));
  });

  return hosts;
}

function hostsAreValid(hosts) {
  return hosts.length > 0 && hosts.every((h) => h.host && h.username && (h.keyPath || h.keyContent));
}

// ---------------------------------------------------------------------------

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
  const payload = { ionos: {}, hosts: [] };
  if (map.IONOS_API_TOKEN !== undefined) payload.ionos.apiToken = map.IONOS_API_TOKEN;
  if (map.IONOS_CONTRACT_NUMBER !== undefined) payload.ionos.contractNumber = map.IONOS_CONTRACT_NUMBER;
  if (map.RHUI_HOSTS_JSON !== undefined) {
    try {
      const parsed = JSON.parse(map.RHUI_HOSTS_JSON);
      if (Array.isArray(parsed)) payload.hosts = parsed;
    } catch (err) {
      payload.hosts = [];
    }
  }
  if (map.RHUI_REPO_FILTER !== undefined) payload.repoFilter = map.RHUI_REPO_FILTER;
  if (map.RHUI_MONITORED_REPOS !== undefined) payload.monitoredRepos = map.RHUI_MONITORED_REPOS;
  return payload;
}

let pollTimer = null;
let currentHosts = [];
let selectedHostIndex = 0;

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

function renderHostHeader(host) {
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

  return `<div class="card">
    <h2>${host.label} ${statusBadge}</h2>
    <div class="subtitle">${host.host} · ${host.osRelease || ''} · SSH latency ${host.connectivity.latencyMs}ms</div>
  </div>`;
}

function renderServerView(host) {
  const servers = (host.serverSide && host.serverSide.servers) || [];
  if (!servers.length) {
    return '<p class="muted">No RHUI server-side data available yet.</p>';
  }
  return `
    <p class="check-explainer">The basics: is the RHUI server itself reachable and does it present a valid certificate? This app has no direct access to RHUI, so these checks run from the client.</p>
    ${servers.map(renderServerBlock).join('')}
  `;
}

function renderClientView(host) {
  const repos = host.clientSide && host.clientSide.repos;
  if (!repos || !repos.length) {
    return '<p class="muted">No RHUI repos were found in /etc/yum.repos.d matching the configured filter. Check the "Repo filter" setting or verify this client is actually registered with RHUI.</p>';
  }

  const repoRows = repos.map(renderRepoRow).join('');

  return `
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
  `;
}

function renderDashboard(host) {
  els.hostHeader.innerHTML = renderHostHeader(host);

  const hasDetail = host.configured && host.connectivity && host.connectivity.reachable && !host.error;
  els.viewServer.innerHTML = hasDetail ? renderServerView(host) : '';
  els.viewClient.innerHTML = hasDetail ? renderClientView(host) : '';
}

function selectView(viewName) {
  els.navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  els.viewServer.classList.toggle('hidden', viewName !== 'server');
  els.viewClient.classList.toggle('hidden', viewName !== 'client');
}

function renderHostSelect() {
  const multi = currentHosts.length > 1;
  els.hostSelectWrap.classList.toggle('hidden', !multi);
  if (!multi) return;
  els.hostSelect.innerHTML = currentHosts
    .map((h, i) => `<option value="${i}">${escapeHtml(h.label)} (${escapeHtml(h.host)})</option>`)
    .join('');
  els.hostSelect.value = String(selectedHostIndex);
}

async function loadStatus(force) {
  try {
    const resp = await fetch(`/api/status${force ? '?refresh=true' : ''}`);
    if (resp.status === 409) {
      show(els.setup);
      return;
    }
    const data = await resp.json();
    currentHosts = data.hosts || [];
    if (selectedHostIndex >= currentHosts.length) selectedHostIndex = 0;
    renderHostSelect();
    renderDashboard(currentHosts[selectedHostIndex] || { configured: false, label: 'No hosts configured' });
    els.lastUpdated.textContent = `Updated ${fmtDate(data.generatedAt)}`;
    show(els.dashboard);
  } catch (err) {
    els.hostHeader.innerHTML = `<p class="error-text">Failed to load status: ${err.message}</p>`;
    show(els.dashboard);
  }
}

function formToConfigPayload(form) {
  const data = new FormData(form);
  const payload = {
    ionos: {
      apiToken: els.ionosApiToken.value,
      contractNumber: els.ionosContractNumber.value,
    },
    hosts: collectHostsPayload(),
  };
  for (const [key, value] of data.entries()) {
    payload[key] = value;
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

function hostsShareSameKey(hosts) {
  if (hosts.length <= 1) return true;
  const [first, ...rest] = hosts;
  return rest.every(
    (h) =>
      h.username === first.username &&
      String(h.port) === String(first.port) &&
      h.keyPath === first.keyPath &&
      h.keyContent === first.keyContent &&
      h.passphrase === first.passphrase
  );
}

async function loadConfigIntoForm() {
  try {
    const resp = await fetch('/api/config');
    const cfg = await resp.json();
    els.ionosApiToken.value = cfg.ionos?.apiToken || '';
    els.ionosContractNumber.value = cfg.ionos?.contractNumber || '';

    const hosts = cfg.hosts || [];
    const useSame = hostsShareSameKey(hosts);
    els.sameKeyToggle.checked = useSame;
    if (hosts.length) {
      const first = hosts[0];
      document.getElementById('shared-username').value = first.username || '';
      document.getElementById('shared-port').value = first.port || 22;
      document.getElementById('shared-keypath').value = first.keyPath || '';
      document.getElementById('shared-keycontent').value = first.keyContent || '';
      document.getElementById('shared-passphrase').value = first.passphrase || '';
    }
    manualHosts = hosts;
    discoveredServers = [];
    els.discoverResults.innerHTML = '';
    els.discoverStatus.textContent = '';
    renderHostsList();
    toggleSameKeyVisibility();

    if (cfg.repoFilter !== undefined) els.setupForm.querySelector('[name="repoFilter"]').value = cfg.repoFilter;
    if (cfg.monitoredRepos && cfg.monitoredRepos.length) {
      els.setupForm.querySelector('[name="monitoredRepos"]').value = cfg.monitoredRepos
        .map((r) => `${r.repoId}|${r.publicRepomdUrl}`)
        .join(';');
    }
  } catch (err) {
    els.setupStatus.textContent = `Could not load existing configuration: ${err.message}`;
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
    await loadConfigIntoForm();
    show(els.setup);
  }
}

els.refreshBtn.addEventListener('click', () => loadStatus(true));

els.hostSelect.addEventListener('change', () => {
  selectedHostIndex = parseInt(els.hostSelect.value, 10) || 0;
  renderDashboard(currentHosts[selectedHostIndex]);
});

els.navItems.forEach((item) => {
  item.addEventListener('click', () => selectView(item.dataset.view));
});

els.viewClient.addEventListener('click', async (e) => {
  const btn = e.target.closest('.fix-btn');
  if (!btn) return;
  const fixId = btn.dataset.fixId;
  const repoIds = JSON.parse(btn.dataset.repoIds || '[]');
  btn.disabled = true;
  btn.textContent = 'Applying fix…';
  try {
    const resp = await fetch(`/api/fix/${selectedHostIndex}/${fixId}`, {
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

els.setupBtn.addEventListener('click', async () => {
  if (pollTimer) clearInterval(pollTimer);
  await loadConfigIntoForm();
  show(els.setup);
});

els.sameKeyToggle.addEventListener('change', toggleSameKeyVisibility);

els.addHostBtn.addEventListener('click', () => {
  manualHosts.push({ label: '', host: '', username: '', port: 22, keyPath: '', keyContent: '', passphrase: '' });
  renderHostsList();
});

els.hostsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.host-row-remove');
  if (!btn) return;
  const index = parseInt(btn.dataset.removeIndex, 10);
  manualHosts.splice(index, 1);
  renderHostsList();
});

els.discoverBtn.addEventListener('click', async () => {
  els.discoverStatus.textContent = 'Searching IONOS Cloud API for RHEL hosts…';
  els.discoverBtn.disabled = true;
  try {
    const resp = await fetch('/api/ionos/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiToken: els.ionosApiToken.value,
        contractNumber: els.ionosContractNumber.value,
      }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Discovery failed');
    discoveredServers = result.servers;
    renderDiscoverResults();
    els.discoverStatus.textContent = discoveredServers.length
      ? `Found ${discoveredServers.length} RHEL host(s). Check the ones you want to monitor.`
      : 'No RHEL hosts found in this contract.';
  } catch (err) {
    els.discoverStatus.textContent = `Error: ${err.message}`;
  } finally {
    els.discoverBtn.disabled = false;
  }
});

els.setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formToConfigPayload(els.setupForm);
  if (!hostsAreValid(payload.hosts)) {
    els.setupStatus.textContent = 'Error: select or add at least one host, each with a host/IP, SSH user, and a key (path or content).';
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
    selectedHostIndex = 0;
    await loadStatus(true);
    pollTimer = setInterval(() => loadStatus(false), 60000);
  } catch (err) {
    els.setupStatus.textContent = `Error: ${err.message}`;
  }
});

els.saveEnvBtn.addEventListener('click', async () => {
  const payload = formToConfigPayload(els.setupForm);
  if (!hostsAreValid(payload.hosts)) {
    els.setupStatus.textContent = 'Error: select or add at least one host, each with a host/IP, SSH user, and a key (path or content).';
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
    selectedHostIndex = 0;
    await loadStatus(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => loadStatus(false), 60000);
  } catch (err) {
    els.setupStatus.textContent = `Error: ${err.message}`;
  } finally {
    e.target.value = '';
  }
});

renderHostsList();
init();
