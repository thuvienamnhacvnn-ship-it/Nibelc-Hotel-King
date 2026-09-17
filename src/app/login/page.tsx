import fs from "node:fs";
import path from "node:path";
import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đăng nhập" };

/**
 * Ảnh banner đăng nhập: chỉ cần thả file vào public/login/ là tự dùng, không phải sửa code.
 *   banner-desktop.(webp|jpg|png) — máy tính, nửa trái màn hình (gợi ý 1600×1800)
 *   banner-mobile.(webp|jpg|png)  — điện thoại, phần trên màn hình (gợi ý 1170×1000)
 * Chưa có ảnh thì dùng nền trang trí navy + ngọn lửa mờ.
 */
function findBanner(name: string): string | null {
  for (const ext of ["webp", "jpg", "jpeg", "png"]) {
    const file = path.join(process.cwd(), "public", "login", `${name}.${ext}`);
    try {
      const stat = fs.statSync(file);
      // Thêm mốc sửa file để trình duyệt tải ảnh mới khi thay banner.
      if (stat.isFile()) return `/login/${name}.${ext}?v=${Math.floor(stat.mtimeMs)}`;
    } catch {
      /* không có file đuôi này */
    }
  }
  return null;
}

export default async function LoginPage() {
  const actor = await currentActor();
  if (actor) redirect(actor.role === "cleaner" ? "/m" : "/");
  const desktop = findBanner("banner-desktop");
  const mobile = findBanner("banner-mobile");
  const style = {
    ...(desktop ? { "--login-banner-desktop": `url("${desktop}")` } : {}),
    ...(mobile ? { "--login-banner-mobile": `url("${mobile}")` } : {}),
  } as CSSProperties;

  return (
    <div className="login" style={style}>
      <aside className="login-hero" data-banner={desktop || mobile ? "true" : "false"}>
        {desktop || mobile ? null : <div className="login-flame" aria-hidden />}
        <div className="login-brand">
          <img src="/logo-vietduc.png" alt="Việt Đức Group" width={64} height={61} />
          <div>
            <div className="login-brand-name">Vietduc Hotel</div>
            <div className="login-brand-sub">Việt Đức Group · Budapest</div>
          </div>
        </div>
        <div className="login-headline">
          <h2>
            Vận hành căn hộ <em>gọn gàng</em>, mọi lúc mọi nơi
          </h2>
          <p>Booking, lịch phòng, dọn phòng và hộp thư khách — tập trung một chỗ cho cả đội Việt Nam và Budapest.</p>
          <div className="login-points">
            <span>Lịch phòng theo thời gian thực</span>
            <span>Điều phối dọn phòng</span>
            <span>Hộp thư & trợ lý khách</span>
          </div>
        </div>
        <div className="login-foot">© {new Date().getFullYear()} Việt Đức Group</div>
      </aside>

      <main className="login-panel">
        <div className="login-card">
          <h1>Đăng nhập</h1>
          <p className="login-lead">Chào mừng trở lại. Nhập tài khoản được cấp để tiếp tục.</p>
          <LoginForm />
          <div className="login-help">Quên mật khẩu? Liên hệ quản trị hệ thống.</div>
        </div>
      </main>
    </div>
  );
}
