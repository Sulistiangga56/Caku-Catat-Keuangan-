require("dotenv").config();
const fs = require('fs');
const path = require('path');
const axios = require("axios");
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const WISHLIST_FILE = path.resolve('./wishlist.json');


// === Helper ===
function loadWishlist() {
    if (!fs.existsSync(WISHLIST_FILE)) return [];
    return JSON.parse(fs.readFileSync(WISHLIST_FILE));
}

function saveWishlist(data) {
    fs.writeFileSync(WISHLIST_FILE, JSON.stringify(data, null, 2));
}

// === Core ===
function addItem(jid, name) {
    const data = loadWishlist();
    const item = { jid, name, price: null, lastChecked: null, url: null };
    data.push(item);
    saveWishlist(data);
    return item;
}

function getUserWishlist(jid) {
    const data = loadWishlist();
    return data.filter(x => x.jid === jid);
}

// === Coba ambil harga lewat Shopee langsung ===
async function getShopeePrice(keyword) {
  console.log(`[bot] 🔎 Mencari harga Shopee untuk: ${keyword}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage();
  const url = `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Deteksi CAPTCHA
    const isCaptcha = await page.$('div.g-recaptcha, .shopee-search-empty-result-section__hint');
    if (isCaptcha) {
      console.warn('[bot] ❌ Shopee menampilkan CAPTCHA — fallback ke Serper API');
      await browser.close();
      return await getSerperPrice(keyword); // fallback
    }

    await page.waitForSelector('.shopee-search-item-result__item', { timeout: 20000 });
    const item = await page.evaluate(() => {
      const el = document.querySelector('.shopee-search-item-result__item');
      if (!el) return null;
      const name = el.querySelector('div[data-sqe="name"]')?.textContent?.trim() || '-';
      const price =
        el.querySelector('.aBrP0c, .hpDKMN, .Z8lP5N, .Ybrg9j, span[data-testid="spnSRPProdPrice"]')?.textContent?.trim() ||
        null;
      const link = el.querySelector('a')?.href || null;
      return { name, price, link };
    });

    await browser.close();
    if (!item || !item.price) {
      console.warn('[bot] ⚠️ Tidak menemukan harga — fallback ke Serper API');
      return await getSerperPrice(keyword);
    }
    return item;
  } catch (err) {
    console.error('[bot] ❌ Gagal ambil harga Shopee:', err.message);
    await browser.close();
    return await getSerperPrice(keyword); // fallback otomatis
  }
}

// === Fallback ke SERPER.DEV ===
async function getSerperPrice(keyword) {
  console.log(`[bot] 🌐 Fallback ke Serper API untuk: ${keyword}`);
  try {
    const res = await axios.post(
      'https://google.serper.dev/search',
      { q: `site:shopee.co.id ${keyword}` },
      {
        headers: {
          'X-API-KEY': process.env.SERPER,
          'Content-Type': 'application/json'
        }
      }
    );

    const result = res.data.organic?.find(r => r.link.includes('shopee.co.id'));
    if (!result) return { error: 'Tidak menemukan hasil di Serper' };

    // Ambil konten HTML dari link produk
    const htmlRes = await axios.get(result.link, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // Cari harga seperti "Rp 499.000" atau "Rp499.000"
    const priceMatch = htmlRes.data.match(/Rp\s?[\d.]+/);
    const price = priceMatch ? priceMatch[0] : null;

    return {
      name: result.title || keyword,
      price,
      link: result.link
    };
  } catch (err) {
    console.error('[bot] ❌ Gagal ambil dari Serper API:', err.message);
    return { error: 'Gagal ambil harga dari Serper API' };
  }
}

// fungsi bantu scroll
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });
    });
}

// === Fungsi yang dipanggil updatePrices ===
async function checkPrice(keyword) {
    const info = await getShopeePrice(keyword);
    if (!info || info.error) {
        console.log(`[bot] ❌ Gagal ambil harga untuk ${keyword}`);
        return null;
    }

    // Ubah format harga "Rp499.000" -> 499000
    const cleanPrice = parseInt((info.price || '').replace(/[^0-9]/g, ''), 10) || null;

    return {
        name: info.name,
        price: cleanPrice,
        link: info.link
    };
}

// === Update Semua Harga Wishlist ===
async function updatePrices() {
    const data = loadWishlist();
    let changed = [];

    for (let item of data) {
        const info = await checkPrice(item.name);
        if (!info) continue;

        if (item.price && info.price && info.price < item.price) {
            changed.push({ ...item, newPrice: info.price });
        }

        item.price = info.price;
        item.url = info.link;
        item.lastChecked = new Date().toISOString();
    }

    saveWishlist(data);
    return changed;
}

(async () => {
  const result = await getShopeePrice('meja gaming');
  console.log(result);
})();

module.exports = {
    addItem,
    getUserWishlist,
    getShopeePrice,
    autoScroll,
    getSerperPrice,
    checkPrice,
    updatePrices
};
