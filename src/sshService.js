const { Client } = require('ssh2');
const fs = require('fs');

function resolvePrivateKey(hostCfg) {
  if (hostCfg.keyPath) {
    return fs.readFileSync(hostCfg.keyPath, 'utf8');
  }
  if (hostCfg.keyContent) {
    // Support keys pasted with literal "\n" sequences instead of real newlines.
    return hostCfg.keyContent.includes('\\n') && !hostCfg.keyContent.includes('\n')
      ? hostCfg.keyContent.replace(/\\n/g, '\n')
      : hostCfg.keyContent;
  }
  throw new Error('No SSH key path or key content configured for this host');
}

function connect(hostCfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    let privateKey;
    try {
      privateKey = resolvePrivateKey(hostCfg);
    } catch (err) {
      reject(err);
      return;
    }

    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH connection to ${hostCfg.host} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn
      .on('ready', () => {
        clearTimeout(timer);
        resolve(conn);
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: hostCfg.host,
        port: hostCfg.port,
        username: hostCfg.username,
        privateKey,
        passphrase: hostCfg.passphrase || undefined,
        readyTimeout: timeoutMs,
      });
  });
}

function exec(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        })
        .on('data', (data) => {
          stdout += data.toString();
        })
        .stderr.on('data', (data) => {
          stderr += data.toString();
        });
    });
  });
}

async function withConnection(hostCfg, timeoutMs, fn) {
  const conn = await connect(hostCfg, timeoutMs);
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

module.exports = { connect, exec, withConnection };
