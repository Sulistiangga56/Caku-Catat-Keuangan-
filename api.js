const express = require('express');
const cors = require('cors');
const { getTransactions, getSummary, getCategorySummary } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// contoh: GET semua transaksi
app.get('/transactions', async (req, res) => {
  try {
    // prefer userId via query; jika tidak ada dan mau, bisa pakai all=1 untuk semua user
    const userId = req.query.userId || null;
    const month = req.query.month || null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;

    // optional: jika ingin mengijinkan semua data tanpa userId, gunakan req.query.all === '1'
    if (!userId && req.query.all !== '1') {
      return res.status(400).json({ error: 'userId required (or use all=1 to fetch all users)' });
    }

    const rows = await getTransactions(userId, { month, limit });
    res.json(rows);
  } catch (err) {
    console.error('GET /transactions error', err);
    res.status(500).json({ error: err.message });
  }
});


// contoh: GET summary (saldo + transaksi)
app.get('/summary', async (req, res) => {
  try {
    const userId = req.query.userId || 'default';
    const month = req.query.month || null;
    const data = await getSummary(userId, month);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// contoh: GET kategori (summary per kategori)
app.get('/categories', async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const month = req.query.month || null;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    const rows = await getCategorySummary(userId, month);
    res.json(rows);
  } catch (err) {
    console.error('GET /categories error', err);
    res.status(500).json({ error: err.message });
  }
});


// nyalakan server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`✅ API server running on port ${PORT}`);
});
