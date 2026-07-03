const express = require('express');
const config = require('../config');
const rhuiChecks = require('../rhuiChecks');
const ionosCloud = require('../ionosCloud');
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
  // This is a single-admin internal tool with no auth layer of its own, so
  // secrets are returned in full to let the setup form pre-populate exactly
  // as entered (matching how it already handles pasted SSH keys).
  res.json({
    ionos: {
      apiToken: cfg.ionos.apiToken,
      contractNumber: cfg.ionos.contractNumber,
    },
    hosts: cfg.hosts,
    repoFilter: cfg.repoFilter,
    monitoredRepos: cfg.monitoredRepos,
    pollIntervalSeconds: cfg.pollIntervalSeconds,
  });
});

router.post('/config', (req, res) => {
  const body = req.body || {};
  const overrides = {};

  if (body.ionos) {
    if (body.ionos.apiToken !== undefined) overrides.IONOS_API_TOKEN = body.ionos.apiToken;
    if (body.ionos.contractNumber !== undefined) overrides.IONOS_CONTRACT_NUMBER = body.ionos.contractNumber;
  }

  if (Array.isArray(body.hosts)) {
    overrides.RHUI_HOSTS_JSON = JSON.stringify(body.hosts);
  }

  if (body.repoFilter !== undefined) overrides.RHUI_REPO_FILTER = body.repoFilter;
  if (body.monitoredRepos !== undefined) overrides.RHUI_MONITORED_REPOS = body.monitoredRepos;

  config.setOverrides(overrides);
  cachedStatus = null;
  res.json({ ok: true, configured: config.isConfigured() });
});

router.post('/ionos/discover', async (req, res) => {
  const body = req.body || {};
  const cfg = config.getConfig();
  const apiToken = body.apiToken || cfg.ionos.apiToken;
  const contractNumber = body.contractNumber !== undefined ? body.contractNumber : cfg.ionos.contractNumber;

  if (!apiToken) {
    res.status(400).json({ ok: false, error: 'IONOS Cloud API token is required' });
    return;
  }

  try {
    const servers = await ionosCloud.discoverRhelServers({ apiToken, contractNumber });
    res.json({ ok: true, servers });
  } catch (err) {
    const message = err.response
      ? `IONOS API error ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    res.status(502).json({ ok: false, error: message });
  }
});

router.post('/fix/:hostIndex/enable-repos', async (req, res) => {
  const cfg = config.getConfig();
  const hostIndex = parseInt(req.params.hostIndex, 10);
  const hostCfg = cfg.hosts[hostIndex];
  if (!hostCfg) {
    res.status(404).json({ ok: false, error: `Unknown host index: ${req.params.hostIndex}` });
    return;
  }
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
