const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment");
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

async function getMotivation(mode = "serius") {
  try {
    const prompt =
      mode === "lucu"
        ? "Buat satu kalimat motivasi pagi yang lucu tapi tetap membangkitkan semangat."
        : mode === "dark"
        ? "Buat satu kalimat motivasi pendek untuk pagi hari dengan nuansa dark humor, bahasa Indonesia, tetap membangkitkan semangat."
        : "Buat satu kalimat motivasi inspiratif pendek untuk pagi hari, bahasa Indonesia.";

    const res = await openai.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.choices?.[0]?.message?.content?.trim();
    return text || "Tetap semangat hari ini! 💪";
  } catch (err) {
    console.error("[bot] getMotivation error:", err.message);
    return "⚠️ Gagal mengambil motivasi hari ini.";
  }
}

function startDailyMotivation(sock, adminJid) {
  console.log("[bot] Daily motivation scheduler aktif ✅");

  // Pagi 05:30
  cron.schedule("30 5 * * *", async () => {
    const quote = await getMotivation("serius");
    await sock.sendMessage(adminJid, {
      text: `Selamat pagi! 🌞 ${quote}`,
    });
  });

  // Malam 22:00
  cron.schedule("0 22 * * *", async () => {
    const quote = await getMotivation("serius");
    await sock.sendMessage(adminJid, {
      text: `Selamat malam! 🌙 ${quote}`,
    });
  });
}

module.exports = { getMotivation, startDailyMotivation };