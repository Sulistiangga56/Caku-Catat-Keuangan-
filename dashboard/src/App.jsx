import React, { useState } from 'react'
import axios from 'axios'
import Summary from './components/Summary'
import TransactionsTable from './components/TransactionsTable'
import CategoryChart from './components/CategoryChart'
import './app.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export default function App() {
  const [userId, setUserId] = useState('');
  const [month, setMonth] = useState('');
  const [summary, setSummary] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);

  const fetchAll = async () => {
    if (!userId) return alert('Masukkan userId');

    try {
      // convert hanya sebelum dikirim
      let monthParam = null;
      if (month) {
        const [y, m] = month.split('-');  // YYYY-MM
        monthParam = `${m}-${y}`;         // MM-YYYY
      }

      const [sumRes, txRes, catRes] = await Promise.all([
        axios.get(`${API}/summary`, { params: { userId, month: monthParam } }),
        axios.get(`${API}/transactions`, { params: { userId, month: monthParam } }),
        axios.get(`${API}/categories`, { params: { userId, month: monthParam } })
      ]);

      setSummary(sumRes.data);
      setTransactions(txRes.data);
      setCategories(catRes.data);
    } catch (e) {
      console.error(e);
      alert('Gagal mengambil data: ' + (e.response?.data?.error || e.message));
    }
  };

  return (
    <div className="container">
      <header>
        <h1>BOCAKU — Personal Finance Dashboard</h1>
      </header>

      <section className="controls">
        <input
          placeholder="Masukkan userId (contoh: 628123...@s.whatsapp.net atau group id)"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="input"
        />
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)} // simpan YYYY-MM langsung
          className="input-month"
        />
        <button onClick={fetchAll} className="btn">Refresh</button>
      </section>

      <Summary data={summary} />
      <CategoryChart data={categories} />
      <TransactionsTable rows={transactions} />
    </div>
  );
}
