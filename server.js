const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./src/config');
const apiRoutes = require('./src/routes/api');

const app = express();
const cfg = config.getConfig();

app.use(express.json({ limit: '256kb' }));
app.use(
  session({
    secret: cfg.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/.env.example', (req, res) => {
  res.download(path.join(__dirname, '.env.example'), 'env.example', { dotfiles: 'allow' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(cfg.port, () => {
  console.log(`IONOS RHUI Status dashboard listening on port ${cfg.port}`);
});
