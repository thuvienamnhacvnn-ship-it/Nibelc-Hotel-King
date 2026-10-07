/**
 * Chuông báo cháy ĐẶT NGOÀI căn nhà.
 *
 * Ngày 06/10/2026 worker chết cả buổi vì mật khẩu cơ sở dữ liệu lệch: lịch không đồng bộ, trợ lý
 * không trả lời ai, việc dọn không sinh — mà không ai biết, vì trang web vẫn trả 200 (trang đăng
 * nhập không chạm cơ sở dữ liệu).
 *
 * Bài học: thứ canh chừng KHÔNG được nằm trong thứ nó canh. Script này chạy bằng systemd timer,
 * độc lập với worker và với app, và báo động thẳng qua Evolution chứ không đi qua hàng đợi gửi tin
 * của app (hàng đợi đó cũng nằm trong worker).
 *
 * Chạy tay:  node scripts/canh-gac.cjs [--thu]      (--thu: gửi thử một tin báo động)
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = "/opt/vd-hotel";
const APP = path.join(ROOT, "app");
const { Client } = require(path.join(APP, "node_modules", "pg"));

/** Nhịp tim cũ hơn mức này coi như worker đã chết. Worker đập mỗi 2 giây nên 10 phút là rất rộng. */
const HEARTBEAT_MAX_MINUTES = 10;
/** Đã báo rồi thì im bấy lâu, tránh dội tin mỗi lần chạy. */
const ALERT_GAP_MINUTES = 60;
const STATE_FILE = path.join(ROOT, "canh-gac-trang-thai.json");

function env() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function kiemTra(e) {
  const loi = [];

  // 1. Cơ sở dữ liệu — chính chỗ hỏng hôm 06/10.
  let beatPhut = null;
  try {
    const c = new Client({ connectionString: e.DATABASE_URL, connectionTimeoutMillis: 8000 });
    await c.connect();
    const r = await c.query("SELECT EXTRACT(EPOCH FROM (now() - last_beat_at))/60 AS phut FROM system_heartbeats WHERE name = 'worker'");
    await c.end();
    beatPhut = r.rows[0] ? Number(r.rows[0].phut) : null;
    if (beatPhut === null) loi.push("Worker chưa từng ghi nhịp tim nào.");
    else if (beatPhut > HEARTBEAT_MAX_MINUTES) loi.push(`Worker đứng im ${Math.round(beatPhut)} phút — lịch không đồng bộ, trợ lý không trả lời ai.`);
  } catch (err) {
    loi.push(`Không vào được cơ sở dữ liệu: ${String(err.message).slice(0, 120)}`);
  }

  // 2. Trang web. Lưu ý: trang đăng nhập trả 200 ngay cả khi DB chết, nên đây chỉ là một phần.
  try {
    const res = await fetch("https://vietduc-hub.com/login", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) loi.push(`Trang web trả mã ${res.status}.`);
  } catch (err) {
    loi.push(`Trang web không trả lời: ${String(err.message).slice(0, 80)}`);
  }

  // 3. Tổng đài WhatsApp còn kết nối không.
  try {
    const base = (e.EVOLUTION_API_URL || "").replace(/\/+$/, "");
    const res = await fetch(`${base}/instance/connectionState/${encodeURIComponent(e.EVOLUTION_INSTANCE || "")}`, {
      headers: { apikey: e.EVOLUTION_API_KEY || "" },
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    const state = j?.instance?.state;
    if (state !== "open") loi.push(`Tổng đài WhatsApp đang ở trạng thái "${state}" — không nhận và gửi tin được.`);
  } catch (err) {
    loi.push(`Không hỏi được tổng đài WhatsApp: ${String(err.message).slice(0, 80)}`);
  }

  return { loi, beatPhut };
}

/** Gửi thẳng qua Evolution, KHÔNG qua hàng đợi của app (hàng đợi nằm trong worker, có thể đang chết). */
async function baoDong(e, text) {
  const base = (e.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const so = (e.CANH_GAC_BAO_CHO || "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);
  if (!base || !so.length) return 0;
  let gui = 0;
  for (const number of so) {
    try {
      const res = await fetch(`${base}/message/sendText/${encodeURIComponent(e.EVOLUTION_INSTANCE || "")}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: e.EVOLUTION_API_KEY || "" },
        body: JSON.stringify({ number, text }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) gui += 1;
    } catch {
      /* im lặng: báo động hỏng thì vẫn phải để script thoát sạch */
    }
  }
  return gui;
}

const docTrangThai = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { dangHong: false, baoLuc: 0 };
  }
};

async function main() {
  const e = env();
  const { loi, beatPhut } = await kiemTra(e);
  const truoc = docTrangThai();
  const bayGio = Date.now();
  const gio = new Date().toLocaleString("vi-VN", { timeZone: "Europe/Budapest" });

  if (loi.length) {
    const daLau = bayGio - (truoc.baoLuc || 0) > ALERT_GAP_MINUTES * 60_000;
    if (!truoc.dangHong || daLau) {
      const tin = `🚨 HỆ THỐNG VIETDUC HOTEL HUB ĐANG HỎNG\n${gio} (giờ Budapest)\n\n${loi.map((x) => `• ${x}`).join("\n")}\n\nTin này do bộ canh gác gửi thẳng, không đi qua hệ thống đang hỏng.`;
      const n = await baoDong(e, tin);
      fs.writeFileSync(STATE_FILE, JSON.stringify({ dangHong: true, baoLuc: bayGio }), { mode: 0o600 });
      console.log(`HONG: ${loi.join(" | ")} — da bao cho ${n} so`);
    } else {
      console.log(`HONG (da bao truoc do, chua toi luc nhac lai): ${loi.join(" | ")}`);
    }
    process.exit(1);
  }

  if (truoc.dangHong) {
    await baoDong(e, `✅ Hệ thống Vietduc Hotel Hub đã chạy lại bình thường.\n${gio} (giờ Budapest)`);
    console.log("da chay lai binh thuong, da bao");
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ dangHong: false, baoLuc: truoc.baoLuc || 0 }), { mode: 0o600 });
  console.log(`OK — nhip tim worker ${beatPhut === null ? "?" : Math.round(beatPhut * 60)} giay truoc`);
}

if (process.argv.includes("--thu")) {
  const e = env();
  baoDong(e, "🔔 Thử chuông: bộ canh gác Vietduc Hotel Hub hoạt động bình thường. Đây chỉ là tin thử.")
    .then((n) => console.log(`da gui thu toi ${n} so`))
    .then(() => process.exit(0));
} else {
  main().catch((err) => {
    console.error("LOI canh gac:", err.message);
    process.exit(2);
  });
}
