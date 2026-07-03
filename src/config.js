const fs = require('fs');
const path = require('path');
require('dotenv').config();

// In-memory overrides collected from the web setup form when no .env value
// is present. Never written to disk unless the user explicitly requests it
// via POST /api/config/save.
let runtimeOverrides = {};

const FIELDS = [
  'PORT',
  'SESSION_SECRET',
  'IONOS_API_TOKEN', 'IONOS_CONTRACT_NUMBER',
  'RHUI_HOSTS_JSON',
  'RHUI_REPO_FILTER', 'RHUI_MONITORED_REPOS', 'SSH_TIMEOUT_MS', 'CDN_TIMEOUT_MS',
  'STATUS_POLL_INTERVAL_SECONDS',
];

function get(name) {
  if (runtimeOverrides[name] !== undefined && runtimeOverrides[name] !== '') {
    return runtimeOverrides[name];
  }
  return process.env[name];
}

function setOverrides(partial) {
  for (const key of Object.keys(partial)) {
    if (FIELDS.includes(key)) {
      runtimeOverrides[key] = partial[key];
    }
  }
}

function clearOverrides() {
  runtimeOverrides = {};
}

function normalizeHost(h, index) {
  return {
    label: h.label || h.host || `Host ${index + 1}`,
    host: h.host || '',
    port: parseInt(h.port || '22', 10),
    username: h.username || '',
    keyPath: h.keyPath || '',
    keyContent: h.keyContent || '',
    passphrase: h.passphrase || '',
  };
}

// Hosts are stored as a single JSON array (RHUI_HOSTS_JSON) rather than
// numbered env vars, since the list can grow to any size via IONOS Cloud API
// discovery. JSON.stringify/.parse already escape/restore embedded newlines
// in pasted key content, so no manual escaping is needed here.
function parseHosts() {
  const raw = get('RHUI_HOSTS_JSON');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeHost);
  } catch (err) {
    return [];
  }
}

// Optional manual mapping used to compare a discovered RHUI repo's metadata
// against the corresponding public Red Hat CDN repo. There is no reliable
// way to derive the public URL from the private RHUI baseurl automatically,
// so this is opt-in: repoId|publicRepomdUrl pairs, semicolon-separated.
function parseMonitoredRepos() {
  const raw = get('RHUI_MONITORED_REPOS') || '';
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [repoId, publicRepomdUrl] = entry.split('|').map((s) => (s || '').trim());
      return { repoId, publicRepomdUrl };
    })
    .filter((r) => r.repoId && r.publicRepomdUrl);
}

function getConfig() {
  return {
    port: parseInt(get('PORT') || '3000', 10),
    sessionSecret: get('SESSION_SECRET') || 'dev-secret-change-me',
    ionos: {
      apiToken: get('IONOS_API_TOKEN') || '',
      contractNumber: get('IONOS_CONTRACT_NUMBER') || '',
    },
    hosts: parseHosts(),
    // Substring match (case-insensitive) against repo id/baseurl used to pick
    // out the RHUI repos from everything in /etc/yum.repos.d on the client.
    repoFilter: get('RHUI_REPO_FILTER') || 'rhui',
    monitoredRepos: parseMonitoredRepos(),
    sshTimeoutMs: parseInt(get('SSH_TIMEOUT_MS') || '8000', 10),
    cdnTimeoutMs: parseInt(get('CDN_TIMEOUT_MS') || '8000', 10),
    pollIntervalSeconds: parseInt(get('STATUS_POLL_INTERVAL_SECONDS') || '60', 10),
  };
}

function hostIsUsable(h) {
  return Boolean(h.host && h.username && (h.keyPath || h.keyContent));
}

function isConfigured() {
  return getConfig().hosts.some(hostIsUsable);
}

function saveOverridesToEnvFile() {
  const cfg = getConfig();
  const lines = [];
  const push = (k, v) => lines.push(`${k}=${(v ?? '').toString().replace(/\r?\n/g, '\\n')}`);
  // RHUI_HOSTS_JSON is already newline-safe (JSON.stringify escapes embedded
  // newlines as literal "\n" within the string) -- do not double-escape it.
  const pushRaw = (k, v) => lines.push(`${k}=${v ?? ''}`);

  push('PORT', cfg.port);
  push('SESSION_SECRET', cfg.sessionSecret);

  push('IONOS_API_TOKEN', cfg.ionos.apiToken);
  push('IONOS_CONTRACT_NUMBER', cfg.ionos.contractNumber);

  pushRaw('RHUI_HOSTS_JSON', JSON.stringify(cfg.hosts));

  push('RHUI_REPO_FILTER', cfg.repoFilter);
  push('RHUI_MONITORED_REPOS', cfg.monitoredRepos.map((r) => `${r.repoId}|${r.publicRepomdUrl}`).join(';'));
  push('SSH_TIMEOUT_MS', cfg.sshTimeoutMs);
  push('CDN_TIMEOUT_MS', cfg.cdnTimeoutMs);
  push('STATUS_POLL_INTERVAL_SECONDS', cfg.pollIntervalSeconds);

  const envPath = path.join(__dirname, '..', '.env');
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  return envPath;
}

module.exports = {
  getConfig,
  setOverrides,
  clearOverrides,
  isConfigured,
  saveOverridesToEnvFile,
  FIELDS,
};
