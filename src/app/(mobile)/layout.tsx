import Link from "next/link";
import { requireActor } from "@/lib/session";
import styles from "./mobile.module.css";
import { MobileLogout, MobileOfflineBanner } from "./mobile-client";

export const dynamic = "force-dynamic";

/** Khung tối giản cho điện thoại cleaner. Không service worker, không lưu dữ liệu việc trên máy. */
export default async function MobileLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor(["cleaning.own", "cleaning.view_all"]);
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/m" className={styles.brand} aria-label="Việc của tôi">
          <img src="/icon.png" alt="" width={28} height={28} />
        </Link>
        <div className={styles.titleBox}>
          <Link href="/m" className={styles.title}>
            Việc của tôi
          </Link>
          <span className={styles.who}>{actor.fullName}</span>
        </div>
        <MobileLogout />
      </header>
      <MobileOfflineBanner />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
