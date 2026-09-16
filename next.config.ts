import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mở bằng 127.0.0.1 khi server khai localhost thì Next 16 chặn tài nguyên dev và trang không hydrate.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["pg", "exceljs"],
  poweredByHeader: false,
};

export default nextConfig;
