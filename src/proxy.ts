import { NextResponse, type NextRequest } from "next/server";

/**
 * Chặn sớm cho mọi trang và API: tham số chứa ký tự NUL (%00) — PostgreSQL không nhận ký tự này
 * trong text nên nếu lọt xuống truy vấn sẽ thành lỗi 500.
 */
export function proxy(req: NextRequest) {
  if (/%00/i.test(req.nextUrl.search)) {
    return new NextResponse("Tham số chứa ký tự không hợp lệ.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|logo-vietduc.png|manifest.webmanifest).*)"],
};
