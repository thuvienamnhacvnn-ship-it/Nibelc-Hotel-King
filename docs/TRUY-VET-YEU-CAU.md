# Bảng truy vết yêu cầu — Đợt 0 + Đợt 1

Nguồn yêu cầu: báo cáo kiểm thử nội bộ (prompt triển khai) và báo cáo kiểm thử nội bộ (đặc tả nghiệp vụ 16/09/2026). Trạng thái ghi theo 5 mức: **Đã chạy & kiểm thử** (có test hoặc lệnh kiểm đã chạy thật) / **Chạy bằng dữ liệu DEMO** (hoạt động, chưa có dữ liệu/kết nối thật) / **Chờ quyết định** (code có nhánh chờ, xem `QUYET-DINH-CAN-CHOT.md`) / **Thiếu dữ liệu** / **Đợt sau** (chưa làm).

**Cập nhật 16/09/2026 (sau vòng sửa QA):** mọi vòng sửa đã commit tại `21a10b4` (`git log` để xem chi tiết). Kết quả kiểm thử chạy lại tại thời điểm này: `npx tsc --noEmit` sạch; `npx vitest run` → **48/48 pass, 8/8 file**. Đã kiểm lại DB dev bằng truy vấn trực tiếp: chỉ còn 2 tổ chức seed (`nibelc-demo`, `don-vi-thu-cach-ly`, tạo lúc 11:10:15) và đúng 13 booking gốc — không còn booking/dữ liệu thử nào do QA/docs-writer tạo trong các vòng trước (mã `QA*` = 0 kết quả). Xem mục 4 để biết chi tiết từng lỗi đã sửa.

## 1. Màn hình (mục 4 của `00_spec_prompt.md`)

| # | Yêu cầu | Module/file | Ca kiểm thử | Tình trạng |
|---|---|---|---|---|
| 1 | Đăng nhập, phân quyền theo vai trò | `src/app/login`, `src/modules/auth/*` | `tests/auth-isolation.test.ts` (4 ca: khoá tạm sau 5 lần sai, hash token phiên...) | Đã chạy & kiểm thử |
| 2 | Tổng quan hôm nay | `src/app/(app)/page.tsx`, `src/modules/overview` | Không có test riêng; QA đọc code + curl thủ công (`03_qa-reviewer_booking-lich.md`) | Chạy bằng dữ liệu DEMO |
| 3 | Booking: bảng, lọc/tìm/sắp xếp, chi tiết, lịch sử, tạo/sửa | `src/app/(app)/bookings/**`, `src/modules/booking/*` | `tests/change-requests.test.ts` (8), QA booking-lich (mặt tiếp giáp UI↔route↔service, cách ly tổ chức, lộ dữ liệu theo quyền — 03_qa-reviewer_booking-lich.md) | Đã chạy & kiểm thử |
| 4 | Lịch phòng: ngày/tuần, nguyên căn/phòng lẻ, cảnh báo xung đột | `src/app/(app)/lich`, `src/modules/calendar` | `tests/inventory.test.ts` (6, tồn/EXCLUDE), QA đọc code + curl | Đã chạy & kiểm thử — xem G5 (`03_qa-reviewer_booking-lich.md`): banner xung đột có thể đếm dư 1 ô ở chế độ 7/14 ngày khi phân bổ trả phòng đúng ngày đầu cửa sổ |
| 5 | Danh mục nhà/phòng: mã chuẩn, quan hệ tài nguyên, listing, trạng thái, dữ liệu cần xác nhận | `src/app/(app)/danh-muc`, `src/modules/catalog` | QA đọc code + curl (PATCH properties/units/listings) | Chạy bằng dữ liệu DEMO — danh mục thật 53 mã/11 nhà mới chạy dry-run, chưa `--apply` (xem mục 3) |
| 6 | Cleaning: lịch điều phối, hạn hoàn thành, nhận/từ chối, checklist, sự cố | `src/app/(app)/cleaning/**`, `src/modules/cleaning/*` | `tests/cleaning.test.ts` (7 khi QA chạy lần đầu, 10 ở lần chạy cuối) + QA cleaning (`03_qa-reviewer_cleaning.md`, 2 lỗi CHẶN + 4 NÊN SỬA — **đã sửa và có test tại commit `457a5ba`**, xem mục "Lỗi đã sửa" bên dưới) | Đã chạy & kiểm thử |
| 7 | Cleaner mobile: việc của tôi, địa chỉ, checklist, ảnh, trạng thái tải, thông báo điều chỉnh | `src/app/(mobile)/m/**` | QA cleaning: cách ly cleaner (404 chéo), không lộ dữ liệu khách, offline chặn nút, nút ≥48px (trừ 1 điểm, xem ghi chú) | Đã chạy & kiểm thử — chưa kiểm bằng trình duyệt thật ở viewport hẹp (chỉ soát CSS/markup, ghi chú 8 trong `03_qa-reviewer_cleaning.md`); nút "Việc của tôi" trên header mobile không đạt 48px (ghi chú 5) |
| 8 | Kiểm phòng: ảnh, nhận xét AI, thiếu bằng chứng, dọn lại, người duyệt | — | — | **Đợt sau** — trang cleaning hiện chỉ có dòng chữ "Đợt 2", không có nút giả |
| 9 | Inbox | — | — | **Đợt sau** — chưa có bảng hội thoại/ticket trong schema, chưa có màn hình |
| 10 | Kho Q&A | — | — | **Đợt sau** |
| 11 | Agent Center | — | — | **Đợt sau** — chưa có job/queue AI nào để giám sát |
| 12 | Báo cáo và cấu hình | — | — | **Đợt sau** — chưa cấu hình người nhận/giờ gửi, chưa gửi ai |
| — | Nhập Excel/docx (không có số thứ tự riêng trong mục 4, nhưng là màn hình Đợt 1 thật) | `src/app/(app)/nhap-excel/**`, `src/modules/imports/*` | `tests/imports.test.ts` (5), `tests/imports-catalog.test.ts` (3) + QA imports (`03_qa-reviewer_imports.md`: 1 CHẶN + 6 NÊN SỬA, **toàn bộ đã sửa và đã commit**, xem mục 4) | Chạy bằng dữ liệu DEMO — logic nhập đã qua vòng sửa QA; danh mục/lịch thật (53 mã/11 nhà, 3.615+ dòng) vẫn chỉ chạy dry-run, chưa `--apply` |
| — | Kết nối (màn hình `/ket-noi`) | `src/app/(app)/ket-noi`, `src/modules/connectors/*` | `tests/connectors.test.ts` (6) | Chạy bằng dữ liệu DEMO — mọi connector `not_configured`, chỉ có connector "demo" mô phỏng sự kiện, không hiện "Hoạt động/đã kết nối" |
| — | Nhật ký (audit) | `src/app/(app)/nhat-ky`, `src/modules/audit` | QA đọc code + curl (lọc theo quyền, cách ly tổ chức) | Đã chạy & kiểm thử |
| — | Duyệt thay đổi (`/duyet`) | `src/app/(app)/duyet` | Nằm trong `tests/change-requests.test.ts` + QA booking-lich | Đã chạy & kiểm thử |

## 2. Quy tắc bất biến (mục 5 của `00_spec_prompt.md` / mục 1 của skill quy ước)

| Quy tắc | Cách thực hiện | Ca kiểm thử | Tình trạng |
|---|---|---|---|
| Một booking nhiều phòng / đổi phòng giữa kỳ | `booking_allocations` nhiều dòng, `replaced_by` | `tests/change-requests.test.ts` (move_unit) | Đã chạy & kiểm thử |
| Nguyên căn/phòng lẻ khai báo bằng tài nguyên dùng chung; đặt phòng lẻ không chặn phòng lẻ khác | `unit_resources`, `resource_claims` theo `resource_id` | `tests/inventory.test.ts` | Đã chạy & kiểm thử |
| Giữ tồn trong giao dịch có chống tranh chấp | `resource_claims_no_overlap` EXCLUDE (gist) + khoá kiểm trước | `tests/inventory.test.ts`, QA imports Q1 (2 apply cùng lúc không nhân bản booking) | Đã chạy & kiểm thử |
| Tách yêu cầu đổi khỏi thay đổi đã xác nhận | bảng `change_requests` riêng `bookings`, `requestChange`/`applyChangeRequest` | `tests/change-requests.test.ts` (8 ca) | Đã chạy & kiểm thử |
| Tách trạng thái booking/lưu trú/thanh toán/cleaning/sẵn sàng | 4 cột trạng thái riêng trên `bookings` + `resource_readiness` riêng | QA booking-lich + cleaning | Đã chạy & kiểm thử |
| UTC + ngày vận hành Europe/Budapest, đổi giờ mùa hè | `src/lib/time.ts` | `tests/time.test.ts` (6 ca, gồm nhảy giờ mùa xuân/thu) | Đã chạy & kiểm thử |
| Tiền là cent, không float | `total_amount_minor bigint`, `src/lib/money.ts` | QA booking-lich (grep, export chia 100 chỉ ở ô Excel) | Đã chạy & kiểm thử |
| Nhập Excel giữ gốc + vị trí, preview, chống lặp | `import_rows.raw/sheet/row_number`, khoá advisory | `tests/imports.test.ts`, QA imports | Đã chạy & kiểm thử — CHẶN C1 đã sửa, xem mục 4 |
| Không xóa mã lặp, không cộng sheet TH+nhà, không tự sửa ngày | `parser.ts` (duplicate_in_file, đối chiếu sheet nhà, cờ ngày mơ hồ không đảo) | `tests/imports.test.ts` + báo cáo dry-run 3.615 dòng thật (`02_import-engineer_bao-cao.md`) | Đã chạy & kiểm thử (dry-run) — chưa `--apply` dữ liệu thật |
| Phí/giảm giá chưa rõ để `active:false` | `src/modules/booking/rules.ts` (`FEE_RULES`, `DISCOUNT_RULES`) | Không có test riêng (không có hành vi để test — mọi rule `active:false`, không được cộng vào booking nào) | Chờ quyết định — xem `QUYET-DINH-CAN-CHOT.md` |

## 3. Ca kiểm thử có ý nghĩa (mục 8 đặc tả, `00_spec_dac-ta.txt`)

| Ca | Kết quả bắt buộc | Tình trạng |
|---|---|---|
| Một sự kiện gửi lại nhiều lần | Một cập nhật, không gửi lặp | Đã chạy & kiểm thử (`tests/connectors.test.ts`, dedupe theo `(connector_id, external_event_id)`) |
| Sự kiện đến sai thứ tự | Không ghi đè trạng thái mới | Đã chạy & kiểm thử (`tests/connectors.test.ts`, kiểm `source_version`) |
| Nguyên căn và phòng lẻ đặt đồng thời | Chỉ một giao dịch hợp lệ chiếm tài nguyên | Đã chạy & kiểm thử (`tests/inventory.test.ts`) |
| Khách xin đổi ngày nhưng chưa duyệt | Giữ booking hiện hành, yêu cầu `pending` | Đã chạy & kiểm thử (`tests/change-requests.test.ts`) |
| Gia hạn khi cleaner đã nhận việc | Cập nhật đúng việc, cần xác nhận, không tự điều cleaner vào phòng đang ở | Đã chạy & kiểm thử — CHẶN C1 (`03_qa-reviewer_cleaning.md`) tìm thấy lỗ hổng ở bước này, **đã sửa tại commit `457a5ba`** (chặn checklist/finish/inspect khi `change_ack_required`); `tests/cleaning.test.ts` 10/10 pass ở lần chạy `npx vitest run` mới nhất (48/48 toàn repo, sau khi mọi vòng sửa QA đã commit ở `21a10b4`) |
| Ảnh thiếu/mờ/trùng; GPU ngừng | Không tự duyệt sạch | **Đợt sau** — chưa có luồng ảnh/AI |
| Khách hỏi sai mã hoặc hỏi mã cửa | Không lộ dữ liệu người khác | **Đợt sau** — chưa có Trợ lý 3/Q&A. Phần liên quan đã làm (cách ly tổ chức, ẩn liên hệ khách theo quyền) đã kiểm thử ở tầng booking/imports |
| Thảo không nhận cuộc gọi | Không báo đã nối, chuyển người dự phòng | **Đợt sau** — chưa có tích hợp thoại |
| Import lặp; dữ liệu ngày mơ hồ | Không nhân bản, vào hàng chờ, giữ dấu vết | Đã chạy & kiểm thử — CHẶN C1 (mã cũng ở sheet Hủy vẫn `ready`) và N1–N6 của `03_qa-reviewer_imports.md` **đã sửa và đã commit** ở `21a10b4` (xem mục 4): mã ở sheet Hủy nay chặn cả dòng sheet nguồn (`listed_in_cancel_sheet`), sheet Hủy không chọn được làm nguồn, hai lượt apply cùng lúc không còn sai trạng thái dòng (khoá lô + "nhận" từng dòng trong cùng giao dịch), kiểm "đã có" xét mọi `source_account`, `is_demo` được kế thừa đúng, khoản thu tách khỏi ghi chú kênh |
| Đồng bộ lỗi và báo cáo ngày | Báo dữ liệu cũ, số liệu khớp truy vấn | Chạy bằng dữ liệu DEMO cho phần đồng bộ connector (`last_success_at`, cảnh báo trên `/ket-noi`); phần "báo cáo ngày" — **Đợt sau** |

## 4. Lỗi QA phát hiện — trạng thái cuối (sau vòng sửa QA, commit `21a10b4`)

Nguồn: báo cáo kiểm thử nội bộ (QA gốc), báo cáo kiểm thử nội bộ / `02_ui-builder_lich-danh-muc.md` / `02_import-engineer_bao-cao.md` (mục "Vòng sửa QA" — báo cáo sửa + kiểm lại), báo cáo kiểm thử nội bộ. Tất cả đã xác nhận **đã sửa, đã commit tại `21a10b4`**, đối chiếu trực tiếp với code hiện tại (không chỉ chép báo cáo):

**Cleaning** (`03_qa-reviewer_cleaning.md`, sửa ở `457a5ba`):
- C1 — thao tác trên việc còn thay đổi chờ xác nhận: `toggleChecklistItem`, `finishTask`, `inspectTask` nay gọi `assertNoPendingChange`.
- C2 — `confirmVacated` chỉ nhận `cleaning.manage`, chặn việc đã đóng/đang dọn và việc tương lai (`409 service_date_in_future`).
- N2 — kiểm "cần dọn lại" (`inspectTask` nhánh `fail`) tích lại checklist về `false`.
- N4 — hủy việc đang dọn (`cancelTask`) trả readiness về `vacated_dirty`.
- N1 (PGlite) — cầu nối `scripts/pglite-server.ts` được vá lại để tránh lệch giao thức sau một câu lệnh lỗi (xem mục "Ghi chú về PGlite dev" trong `README.md`).
- N3 (giờ không kèm múi) — chưa thấy ghi nhận đã sửa trong các báo cáo đọc được; coi là còn mở.

**Booking/lịch/danh mục/kết nối** (`03_qa-reviewer_booking-lich.md`, sửa ở `21a10b4` theo `02_ui-builder_booking.md` + `02_ui-builder_lich-danh-muc.md`):
- N1 — `sort` whitelist dùng `Object.hasOwn` thay vì `in` (áp dụng cho cả `queries.ts` của booking và imports).
- N2 — id không phải UUID → `404` ở mọi route `[id]` liên quan (`bookings`, `change-requests`, `conflicts`, `inventory-blocks`, `catalog/{units,listings,properties}`, `connectors/:id/{pause,demo}`) — kiểm cả ở lớp `api()` (`src/lib/http.ts`, tự động cho mọi tham số `id`/`...Id`) lẫn ở service.
- N3 — `page` bất thường (`1e20`...) tự kẹp về khoảng an toàn 1–100.000 ở `pageParams` và ở hai trang tự tính `page` (`/nhat-ky`, `/ket-noi`).
- N4 — `demo-feed.ts` không còn UPDATE thẳng `bookings`/`guests`; `ingest.ts` tự gắn `is_demo`.
- N5 — CSRF: thiếu `Origin` bắt buộc `Sec-Fetch-Site` là `same-origin`/`none`, thiếu cả hai → `403 cross_origin`.
- G1 — audit trong chi tiết booking che khoá khách khi thiếu `booking.view_guest_contact`, cùng quy tắc với `/api/v1/audit`.
- G2 — nhắc "không ghi SĐT/email khách vào ghi chú" hiện trên các ô ghi chú tự do.
- G4 — reject với id sai tổ chức/không tồn tại trả `404` (kiểm tồn tại trước kiểm quyền).
- G5 — `conflictCount` chỉ đếm phân bổ còn đêm thật trong cửa sổ xem.
- G6 — chạy lại đúng request nghi ngờ 3 lần đều `404`, không tái hiện 500/401 thoáng qua.
- **Còn mở**: G3 (`updateBookingDetails` không kiểm riêng `booking.view_guest_contact` khi nhận trường `guest` — hiện không khai thác được vì mọi vai trò có `booking.edit` cũng có quyền xem liên hệ khách, nhưng vẫn là thiếu kiểm tầng service).

**Nhập Excel/docx** (`03_qa-reviewer_imports.md`, sửa ở `21a10b4` theo `02_import-engineer_bao-cao.md` mục 7):
- C1 — mã cũng có ở sheet Hủy: lý do mới `listed_in_cancel_sheet` (chặn) gắn cho mọi dòng sheet nguồn cùng mã.
- N1 — chọn sheet Hủy làm nguồn bị từ chối (`422 cancel_sheet_as_source`), ô chọn sheet không liệt kê Hủy.
- N2 — hai lượt apply cùng lúc: khoá lô (`FOR UPDATE`) + cờ `applying` (hết hạn sau 30 phút), mỗi dòng "nhận" trong cùng giao dịch với booking; lượt thua nhận `409 batch_applying`; lô không còn dòng `ready` → `409 no_ready_rows`.
- N3 — kiểm "đã có" khi apply nay xét mọi `source_account` (không chỉ tài khoản rỗng).
- N4 — `is_demo` của tổ chức được đọc và ghi vào `guests`/`bookings` khi nhập.
- N5 — khoản thu trong ghi chú luôn được tách (`payment_note`), không còn lẫn số tiền vào `channel_note`; người thiếu `revenue.view` thấy `[ẩn khoản thu]`.
- N6 — `batchId` không phải UUID → `404` (thay vì `500`).
- G1 — trích email chặt hơn: chỉ nhận email ngay sau đầu dòng/khoảng trắng/`:`/`–`/`-`, mỗi dòng lấy email đầu tiên — không còn lọt mật khẩu dính trước email.
- G4 — huỷ lô (`discard`) nay yêu cầu quyền **`import.apply`** (trước đó là `import.preview`, không khớp UI) — **API.md đã cập nhật theo quyền mới**.
- Lọc lý do dòng nhập (`issue=`) cũng đổi sang `Object.hasOwn`.
- **Còn mở** (xác nhận trong `02_import-engineer_bao-cao.md`, đúng như QA ghi, chưa có báo cáo nào nhận đã sửa): G2 (cột "Chi tiết phòng" docx ghi nguyên văn vào `bed_config`, cần người xem nội dung cột trước khi `--apply` dữ liệu thật), G5 phần "hàng kiểm tra không có đường ra sau khi lô đã áp dụng", G6 (ẩn liên hệ khách chỉ nhận đúng tiêu đề cột `KHÁCH`/`SĐT`), G7 (chỉ nhận tên sheet chuẩn hoá đúng "huy" là sheet Hủy), G8 (xem trước đổi `needs_review` → `already_imported` có thể che dấu hiệu hủy/mâu thuẫn của booking đã tồn tại).

**Lõi** (`loi-loi.md` mục "Orchestrator đã xử lý") — `resolveIncident` chỉ đổi readiness khi sự cố vừa đóng là `blocking`; `inbound_events.processed_at` dùng `clock_timestamp()`; booking/khách từ connector `status=demo` mang `is_demo=true`. Đã sửa, đã commit.

**Dữ liệu dev**: DB đã được làm sạch và seed lại sau các vòng QA — đã tự kiểm bằng truy vấn trực tiếp (16/09/2026): 2 tổ chức (`nibelc-demo`, `don-vi-thu-cach-ly`), đúng 13 booking, không còn booking/dữ liệu thử nào của các vòng QA trước (`external_ref LIKE 'QA%'` → 0 dòng).
