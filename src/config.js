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
  'HOST_LABEL', 'HOST_HOST', 'HOST_SSH_PORT', 'HOST_SSH_USER',
  'HOST_SSH_KEY_PATH', 'HOST_SSH_KEY_CONTENT', 'HOST_SSH_PASSPHRASE',
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

// The RHEL release (8/9/etc.) isn't asked for -- it's detected live from the
// client itself (/etc/redhat-release) once connected.
function parseHostConfig() {
  return {
    label: get('HOST_LABEL') || 'Test client',
    host: get('HOST_HOST') || '',
    port: parseInt(get('HOST_SSH_PORT') || '22', 10),
    username: get('HOST_SSH_USER') || '',
    keyPath: get('HOST_SSH_KEY_PATH') || '',
    keyContent: get('HOST_SSH_KEY_CONTENT') || '',
    passphrase: get('HOST_SSH_PASSPHRASE') || '',
  };
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
    host: parseHostConfig(),
    // Substring match (case-insensitive) against repo id/baseurl used to pick
    // out the RHUI repos from everything in /etc/yum.repos.d on the client.
    repoFilter: get('RHUI_REPO_FILTER') || 'rhui',
    monitoredRepos: parseMonitoredRepos(),
    sshTimeoutMs: parseInt(get('SSH_TIMEOUT_MS') || '8000', 10),
    cdnTimeoutMs: parseInt(get('CDN_TIMEOUT_MS') || '8000', 10),
    pollIntervalSeconds: parseInt(get('STATUS_POLL_INTERVAL_SECONDS') || '60', 10),
  };
}

function isConfigured() {
  const h = getConfig().host;
  return Boolean(h.host && h.username && (h.keyPath || h.keyContent));
}

function saveOverridesToEnvFile() {
  const cfg = getConfig();
  const lines = [];
  const push = (k, v) => lines.push(`${k}=${(v ?? '').toString().replace(/\r?\n/g, '\\n')}`);

  push('PORT', cfg.port);
  push('SESSION_SECRET', cfg.sessionSecret);

  push('HOST_LABEL', cfg.host.label);
  push('HOST_HOST', cfg.host.host);
  push('HOST_SSH_PORT', cfg.host.port);
  push('HOST_SSH_USER', cfg.host.username);
  push('HOST_SSH_KEY_PATH', cfg.host.keyPath);
  push('HOST_SSH_KEY_CONTENT', cfg.host.keyContent);
  push('HOST_SSH_PASSPHRASE', cfg.host.passphrase);

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
