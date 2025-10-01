import React from 'react';
import { Pie } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
ChartJS.register(ArcElement, Tooltip, Legend);

export default function CategoryChart({ data = [] }) {
  if (!data.length) return <div style={{ margin: '1rem 0' }}>Tidak ada data kategori</div>;

  const labels = data.map(d => d.category || 'Uncategorized');
  const values = data.map(d => Math.abs(Number(d.total || 0)));

  const COLORS = [
    '#3b82f6', '#22c55e', '#ef4444', '#f59e0b',
    '#4f46e5', '#8b5cf6', '#14b8a6', '#ec4899', '#a16207'
  ];

  const chartData = {
    labels,
    datasets: [
      {
        data: values,
        backgroundColor: labels.map((_, i) => COLORS[i % COLORS.length]),
        borderWidth: 1,
      },
    ],
  };

  return (
    <div style={{ width: '600px', maxWidth: '100%' }}>
      <h3>Proporsi Kategori</h3>
      <Pie data={chartData} />
    </div>
  );
}
