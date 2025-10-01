## 5. Cara Penggunaan & Contoh Pesan

Berikut adalah beberapa contoh pesan yang dapat digunakan untuk mengoperasikan aplikasi:

### Tambah Pemasukan
```
+100000 Gaji [salary]
```

### Tambah Pengeluaran
```
-50000 Makan siang [food]
```

### Laporan Terkini
```
laporan
```

### Laporan Bulanan
```
laporan bulan 09-2025
```

### Laporan per Kategori
```
laporan kategori food
```

### Export (XLSX & PDF)
```
laporan export 09-2025
```

### Grafik Kategori (Menghasilkan Gambar)
```
grafik 09-2025
```

### Set Target
```
target 10000000
```

### Set Reminder Harian (misal: 21:00)
```
reminder 21:00
```

### Hapus Data
```
hapus 12
```

### Edit Data
```
edit 12 -70000 Makan malam [food]
```

### Bantuan
```
help
```


### DEPLOY
9) Deploy / production (singkat)

Build frontend: di folder dashboard/ jalankan npm run build → menghasilkan dashboard/dist.

Set environment var NODE_ENV=production lalu jalankan node api.js (atau pm2 start api.js --name caku-api --env production).

Jalankan bot dengan PM2: pm2 start index.js --name caku-bot.

Pastikan port 5000 terbuka dan reverse proxy (Nginx) jika perlu.

Contoh PM2:

npm install -g pm2
pm2 start index.js --name caku-bot
pm2 start api.js --name caku-api --env production
pm2 save

10) Troubleshooting umum (cek kalau ada masalah)

API 500 error → cek console, biasanya koneksi DB gagal. Pastikan MySQL jalan & db.js kredensial benar.

CORS issue → pastikan app.use(cors()) aktif di api.js.

Frontend tidak mau fetch → periksa API URL di App.jsx (use VITE_API_URL atau default http://localhost:5000).

Jika getTransactions error tentang LIMIT ? → pastikan kamu tidak memanggil getTransactions tanpa userId (API mewajibkan userId di URL).