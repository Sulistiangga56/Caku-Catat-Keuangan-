import React from 'react';

export default function TransactionsTable({ rows = [] }) {
  return (
    <div className="table-wrap">
      <h3>Transaksi</h3>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Tanggal</th><th>Amount</th><th>Description</th><th>Category</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.created_at ? new Date(r.created_at).toLocaleString() : '-'}</td>
              <td style={{ color: r.amount < 0 ? 'red' : 'green' }}>
                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(r.amount)}
              </td>
              <td>{r.description || '-'}</td>
              <td>{r.category || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
