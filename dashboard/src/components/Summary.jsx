import React from 'react';

export default function Summary({ data }) {
  if (!data) return null;
  const { saldo, rows } = data;
  const income = (rows || []).filter(r => r.amount > 0).reduce((a, b) => a + b.amount, 0);
  const expense = (rows || []).filter(r => r.amount < 0).reduce((a, b) => a + b.amount, 0);

  return (
    <div className="summary">
      <div className="card">
        <h3>Saldo</h3>
        <p className="big">{new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(saldo)}</p>
      </div>
      <div className="card">
        <h4>Pemasukan</h4>
        <p>{new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(income)}</p>
      </div>
      <div className="card">
        <h4>Pengeluaran</h4>
        <p>{new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(Math.abs(expense))}</p>
      </div>
    </div>
  );
}
