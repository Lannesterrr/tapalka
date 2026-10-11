const path = require('path');
const express = require('express');
const { ENV } = require('./config');
require('./db');
const bot = require('./bot');
const jobs = require('./jobs');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

app.use('/api', require('./api'));
app.use('/admin/api', require('./admin'));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '1h' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера, попробуй ещё раз' });
});

app.listen(ENV.PORT, () => console.log(`Сервер: http://localhost:${ENV.PORT}  ·  админка: /admin`));

bot.start().catch(e => console.error('Не удалось запустить бота:', e.message));
jobs.start();

process.on('unhandledRejection', e => console.error('unhandled', e));
