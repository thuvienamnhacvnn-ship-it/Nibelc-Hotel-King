import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Vietduc Hotel", template: "%s · Vietduc Hotel" },
  description: "Vietduc Hotel — vận hành căn hộ cho thuê: booking, lịch phòng, cleaning",
  manifest: "/manifest.webmanifest",
  // Thêm ra màn hình chính trên iPhone/Android: mở như app riêng, thanh trạng thái hoà màu navy.
  appleWebApp: { capable: true, title: "VD Hotel", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b1f3a",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
