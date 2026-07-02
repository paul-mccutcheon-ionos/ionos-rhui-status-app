module.exports = {
  apps: [
    {
      name: 'ionos-rhui-status-app',
      script: 'server.js',
      cwd: '/opt/ionos-rhui-status-app',
      env: { PORT: 3006 },
    },
  ],
};
