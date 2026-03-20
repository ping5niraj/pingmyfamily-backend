require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ service: 'PingMyFamily API', status: 'running', version: '2.1.0' });
});

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/relationships', require('./routes/relationships'));
app.use('/api/photos',        require('./routes/photos'));
app.use('/api/messages',      require('./routes/messages'));
app.use('/api/locations',     require('./routes/locations'));
app.use('/api/birthdays',     require('./routes/birthdays'));
app.use('/api/quiz',          require('./routes/quiz'));

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`PingMyFamily API running on port ${PORT}`);
});
