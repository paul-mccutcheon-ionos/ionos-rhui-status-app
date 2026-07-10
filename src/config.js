require('dotenv').config();

// In-memory overrides collected from the web setup form when no .env value
// is present. Configuration is never written to disk by this app -- it must
// be re-supplied (via .env at startup, or the setup form / uploaded .env)
// each time the process starts, by policy.
let runtimeOverrides = {};

const FIELDS = [
  'PORT',
  'SESSION_SECRET',
  'IONOS_API_TOKEN', 'IONOS_CONTRACT_NUMBER',
  'RHUI_HOSTS_JSON',
  'HOST_SSH_USER', 'HOST_SSH_PORT', 'HOST_SSH_KEY_PATH', 'HOST_SSH_KEY_CONTENT', 'HOST_SSH_PASSPHRASE',
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

// Fallback SSH credentials applied to any host in RHUI_HOSTS_JSON that
// doesn't specify its own -- lets a hand-authored .env list hosts with just
// host/label and set one shared key/user via plain env vars, instead of
// embedding key content inside the JSON for every entry.
function hostDefaults() {
  return {
    username: get('HOST_SSH_USER') || '',
    port: get('HOST_SSH_PORT') || '22',
    keyPath: get('HOST_SSH_KEY_PATH') || '',
    keyContent: get('HOST_SSH_KEY_CONTENT') || '',
    passphrase: get('HOST_SSH_PASSPHRASE') || '',
  };
}

// Users naturally type "host:port" into a single address field (it's a
// common enough convention, e.g. NAT/load-balancer endpoints like
// "77.68.66.159:222"). Without this, that whole string gets passed to
// getaddrinfo as a hostname and fails to resolve. Only splits on a single
// trailing ":<digits>" so IPv6 literals (multiple colons) are left alone.
function splitHostPort(rawHost) {
  const match = /^([^\s:]+):(\d+)$/.exec((rawHost || '').trim());
  return match ? { host: match[1], port: match[2] } : { host: (rawHost || '').trim(), port: null };
}

function normalizeHost(h, index, defaults) {
  const { host, port: embeddedPort } = splitHostPort(h.host);
  return {
    label: h.label || h.host || `Host ${index + 1}`,
    host,
    port: parseInt(embeddedPort || h.port || defaults.port || '22', 10),
    username: h.username || defaults.username || '',
    keyPath: h.keyPath || defaults.keyPath || '',
    keyContent: h.keyContent || defaults.keyContent || '',
    passphrase: h.passphrase || defaults.passphrase || '',
  };
}

// The same server can easily end up in the submitted list twice -- e.g.
// checked in the IONOS discovery results and also present as a manually
// added host row -- since the setup form has no visibility into the other
// section when building its payload. Dedupe by connect address (host:port,
// case-insensitive) so it's never checked/monitored twice, keeping the
// first occurrence's label/credentials.
function dedupeHosts(hosts) {
  const seen = new Set();
  return hosts.filter((h) => {
    const key = `${(h.host || '').toLowerCase()}:${h.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Hosts are stored as a single JSON array (RHUI_HOSTS_JSON) rather than
// numbered env vars, since the list can grow to any size via IONOS Cloud API
// discovery. JSON.stringify/.parse already escape/restore embedded newlines
// in pasted key content, so no manual escaping is needed here.
function parseHosts() {
  const raw = get('RHUI_HOSTS_JSON');
  if (!raw) return [];
  const defaults = hostDefaults();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return dedupeHosts(arr.map((h, i) => normalizeHost(h, i, defaults)));
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

module.exports = {
  getConfig,
  setOverrides,
  clearOverrides,
  isConfigured,
  FIELDS,
};
