# Nibelc Hotel King

Webapp vận hành các căn hộ cho thuê tại Budapest: booking, lịch phòng, danh mục nhà/phòng, điều phối dọn phòng (cleaning), nhập dữ liệu từ Excel/Word, kết nối kênh bán (đang ở mức DEMO). Đích cuối là nền tảng dùng chung cho ba trợ lý AI (Booking, Cleaning, Guest Support) và Agent Manager mô tả trong đặc tả gốc — bản hiện tại là phần lõi nghiệp vụ + giao diện vận hành cho người, **chưa có trợ lý AI nào chạy**.

Tài liệu này nói về **Đợt 0 và Đợt 1** (đã làm). Đợt 2–4 (ảnh/QC AI, Inbox, Q&A, Agent Center, báo cáo tự động, kết nối kênh thật, thoại/WhatsApp/Viber, đặt phòng trực tiếp + thanh toán, diễn tập backup) **chưa làm** — không có nút nào cho các phần này trong giao diện hiện tại.

## Yêu cầu máy

- Node.js ≥ 22.
- Không cần cài PostgreSQL: máy dev dùng PGlite (Postgres biên dịch WASM) qua `scripts/pglite-server.ts`, vì Windows Smart App Control chặn cài PostgreSQL thật trên máy này. Xem `scripts/pglite-server.ts` (lý do ở đầu file) và `docs/TRIEN-KHAI-VA-SAO-LUU.md` mục "Khác biệt dev/production".
- **Đã vá lỗi cầu nối PGlite** (commit `457a5ba`): trước đó một câu lệnh lỗi có thể làm request song song khác nhận nhầm kết quả (401/404/500 thoáng qua không tương ứng với request thật — ghi trong báo cáo kiểm thử nội bộ). Sau khi vá, kiểm tải trộn (request đọc + ghi chạy song song) cho **120/120 request đúng kết quả**. Vẫn nên coi PGlite là đặc thù máy dev, không phải bằng chứng hành vi khoá thật của PostgreSQL — xem `docs/TRIEN-KHAI-VA-SAO-LUU.md`.

## Chạy dev

Mở 3 terminal (thứ tự quan trọng ở lần đầu):

```bash
npm install
npm run db:dev       # terminal 1 — giữ mở; dựng PGlite, nghe cổng DEV_PG_PORT (mặc định 55480)
npm run db:migrate   # terminal 2 — áp migrations/*.sql (chỉ cần chạy khi có migration mới)
npm run db:seed      # chỉ chạy MỘT LẦN — đã seed rồi thì lệnh tự bỏ qua (kiểm tổ chức nibelc-demo)
npm run dev           # terminal 2 — web tại http://localhost:3080
npm run worker        # terminal 3 — xử lý outbox (lập việc dọn khi booking đổi...)
```

Web vẫn chạy được khi worker tắt — việc dọn chỉ chậm cập nhật; trang Tổng quan hiện số sự kiện đang chờ.

`.env.example` không chứa bí mật thật — copy thành `.env.local` nếu cần đổi cổng/thư mục dữ liệu.

**Giới hạn PGlite (chỉ máy dev):** một tiến trình `db:dev` chỉ mở được một thư mục dữ liệu tại một thời điểm — không chạy hai lệnh `db:dev` cùng lúc trên cùng thư mục. Không tự tắt/khởi động lại `db:dev`/`dev`/`worker` đang chạy của người khác.

## Tài khoản DEMO

Mật khẩu chung: `Demo-Nibelc-2026`. Domain `demo.nibelc.local`, tất cả thuộc tổ chức `nibelc-demo` trừ dòng cuối:

| Email | Vai trò | Ghi chú |
|---|---|---|
| `admin@demo.nibelc.local` | admin | mọi quyền |
| `diu@demo.nibelc.local` | vn_manager | Vietnam Team — phụ trách chính, duyệt thay đổi/giảm giá |
| `hoa@demo.nibelc.local` | vn_staff | Vietnam Team |
| `thao@demo.nibelc.local` | bp_coordinator | Budapest Team — điều phối, duyệt phòng sẵn sàng |
| `budapest@demo.nibelc.local` | bp_staff | Budapest Team |
| `ngoc@demo.nibelc.local` | manager_viewer | xem báo cáo/doanh thu, không sửa |
| `cleaner.a/b/c@demo.nibelc.local` | cleaner | chỉ thấy `/m` (mobile), việc được giao |
| `admin@cach-ly.demo.local` | admin | tổ chức khác (`don-vi-thu-cach-ly`) — dùng để kiểm cách ly dữ liệu, không thấy gì của `nibelc-demo` |

Xem bảng quyền đầy đủ ở `src/modules/auth/permissions.ts`.

DB dev đã được dựng lại sạch và seed lại sau các vòng QA (16/09/2026) — chỉ còn đúng dữ liệu từ `npm run db:seed` (2 tổ chức, 13 booking gốc), không còn booking/dữ liệu thử của các phiên kiểm thử trước.

## Lệnh test

```bash
npx tsc --noEmit    # kiểm kiểu, phải sạch
npx vitest run       # tự dựng DB thử riêng (không chạm DB dev); hiện 48/48 pass (8 file) — xem docs/TRUY-VET-YEU-CAU.md để biết chi tiết từng ca
```

## Cấu trúc thư mục

```
src/app/(app)/...        Màn hình cho nhân viên (booking, lịch, danh mục, cleaning điều phối, duyệt, kết nối, nhật ký, nhập Excel)
src/app/(mobile)/m/...   Màn hình cleaner trên điện thoại
src/app/api/v1/...        Route API — xem docs/API.md
src/modules/<tên>/        service.ts (quy tắc nghiệp vụ) + queries.ts (đọc) theo từng lĩnh vực: booking, inventory, cleaning, catalog, connectors, imports, calendar, audit, outbox, auth, overview, system
src/lib/                  hạ tầng dùng chung: db, http, time, money, session, errors
migrations/0001_core.sql  schema (một file cho Đợt 0–1)
scripts/                  migrate, seed dữ liệu DEMO, chạy PGlite dev, nhập Excel/docx qua CLI
tests/                    48 ca kiểm thử (vitest) — xem docs/TRUY-VET-YEU-CAU.md
_workspace/                báo cáo làm việc + QA của các đợt xây dựng (không phải tài liệu vận hành)
```

## Giới hạn hiện tại

- **Dữ liệu chính thức: chưa có.** Toàn bộ dữ liệu trong DB dev là DEMO ẩn danh (nhãn "DEMO" trên mọi màn hình). Danh mục 53 mã sản phẩm/11 nhà thật và 3.615+ dòng booking thật mới chỉ chạy thử ở chế độ đọc (dry-run), **chưa `--apply` vào cơ sở dữ liệu nào**. Xem `docs/QUYET-DINH-CAN-CHOT.md`.
- **Kết nối kênh bán: tất cả "Chưa cấu hình".** Không có kết nối Airbnb/Booking.com thật. Có một connector "demo" mô phỏng sự kiện để test luồng — giao diện luôn ghi rõ đây không phải kết nối thật.
- **Chưa có:** ảnh/QC AI, Inbox hội thoại, kho Q&A, Agent Center, báo cáo tự động gửi Ngọc/Dịu, kết nối thoại/WhatsApp/Viber, đặt phòng trực tiếp + thanh toán. Không có nút giả cho các phần này.
- **Backup/restore:** chưa từng chạy thật (chưa có VPS/production). `docs/TRIEN-KHAI-VA-SAO-LUU.md` là đề xuất kiến trúc, không phải việc đã làm.
- Chi tiết đầy đủ theo từng yêu cầu → `docs/TRUY-VET-YEU-CAU.md`. Các quyết định nghiệp vụ đang chờ Sếp/Dịu/Thảo/Ngọc chốt → `docs/QUYET-DINH-CAN-CHOT.md`.
