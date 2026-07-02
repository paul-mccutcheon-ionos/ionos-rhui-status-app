const express = require('express');
const config = require('../config');
const rhuiChecks = require('../rhuiChecks');
const packageJson = require('../../package.json');

const router = express.Router();

let cachedStatus = null;
let lastCheckAt = null;
let checkInFlight = null;

async function refreshStatus() {
  if (checkInFlight) return checkInFlight;
  checkInFlight = rhuiChecks
    .checkAll(config.getConfig())
    .then((result) => {
      cachedStatus = result;
      lastCheckAt = Date.now();
      return result;
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

router.get('/version', (req, res) => {
  res.json({ version: packageJson.version });
});

router.get('/config/status', (req, res) => {
  res.json({ configured: config.isConfigured() });
});

router.get('/config', (req, res) => {
  const cfg = config.getConfig();
  const h = cfg.host;
  res.json({
    host: {
      label: h.label,
      host: h.host,
      port: h.port,
      username: h.username,
      keyPath: h.keyPath,
      hasKeyContent: Boolean(h.keyContent),
      hasPassphrase: Boolean(h.passphrase),
    },
    repoFilter: cfg.repoFilter,
    monitoredRepos: cfg.monitoredRepos,
    pollIntervalSeconds: cfg.pollIntervalSeconds,
  });
});

router.post('/config', (req, res) => {
  const body = req.body || {};
  const overrides = {};
  const h = body.host || {};

  if (h.label !== undefined) overrides.HOST_LABEL = h.label;
  if (h.host !== undefined) overrides.HOST_HOST = h.host;
  if (h.port !== undefined) overrides.HOST_SSH_PORT = String(h.port);
  if (h.username !== undefined) overrides.HOST_SSH_USER = h.username;
  if (h.keyPath !== undefined) overrides.HOST_SSH_KEY_PATH = h.keyPath;
  if (h.keyContent !== undefined) overrides.HOST_SSH_KEY_CONTENT = h.keyContent;
  if (h.passphrase !== undefined) overrides.HOST_SSH_PASSPHRASE = h.passphrase;

  if (body.repoFilter !== undefined) overrides.RHUI_REPO_FILTER = body.repoFilter;
  if (body.monitoredRepos !== undefined) overrides.RHUI_MONITORED_REPOS = body.monitoredRepos;

  config.setOverrides(overrides);
  cachedStatus = null;
  res.json({ ok: true, configured: config.isConfigured() });
});

router.post('/config/save', (req, res) => {
  try {
    const envPath = config.saveOverridesToEnvFile();
    res.json({ ok: true, savedTo: envPath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/fix/enable-repos', async (req, res) => {
  const cfg = config.getConfig();
  const hostCfg = cfg.host;
  const repoIds = Array.isArray(req.body?.repoIds) ? req.body.repoIds : [];
  if (!repoIds.length) {
    res.status(400).json({ ok: false, error: 'repoIds is required' });
    return;
  }
  try {
    const result = await rhuiChecks.enableRepos(hostCfg, repoIds, cfg.sshTimeoutMs);
    cachedStatus = null;
    res.json({ ok: result.success, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/status', async (req, res) => {
  if (!config.isConfigured()) {
    res.status(409).json({ error: 'Not configured. Submit configuration via POST /api/config first.' });
    return;
  }

  const force = req.query.refresh === 'true';
  const stale = !lastCheckAt || Date.now() - lastCheckAt > config.getConfig().pollIntervalSeconds * 1000;

  try {
    if (force || stale || !cachedStatus) {
      await refreshStatus();
    }
    res.json(cachedStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
