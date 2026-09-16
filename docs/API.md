# API `/api/v1` — Nibelc Hotel King

Tài liệu dành cho người viết code (agent QA/UI, tích hợp sau này). Nguồn sự thật là code trong `src/app/api/v1/**/route.ts` — tài liệu này liệt kê lại, không thay thế code.

## Chuẩn chung

- **Xác thực:** cookie phiên (`SESSION_COOKIE`, xem `src/modules/auth/sessions.ts`). Đăng nhập qua `POST /api/v1/auth/login`. Không có Bearer token.
- **CSRF:** mọi request ghi (POST/PATCH/PUT/DELETE) phải cùng gốc (`Origin` khớp `Host`, hoặc thiếu `Origin` thì `Sec-Fetch-Site` phải là `same-origin`/`none`). Thiếu cả hai header, hoặc `Origin` khác gốc → `403 cross_origin`. Gọi bằng curl/script phải tự thêm header `Origin: http://localhost:3080`.
- **Thành công:** JSON trực tiếp (object) hoặc `{ items, page, pageSize, total }` cho danh sách phân trang.
- **Lỗi:** `{ error: { code, message, details? } }` với HTTP status tương ứng:
  | Status | Khi nào |
  |---|---|
  | 400 | body không phải JSON hợp lệ |
  | 401 | chưa đăng nhập / phiên hết hạn |
  | 403 | không đủ quyền, hoặc cross-origin |
  | 404 | không tìm thấy (gồm cả id sai định dạng UUID, và bản ghi của tổ chức khác — không phân biệt hai trường hợp để không lộ dữ liệu tồn tại) |
  | 409 | xung đột trạng thái/phiên bản (`stale_version`, `inventory_conflict`, `invalid_transition`, `change_ack_required`, `file_already_applied`...) |
  | 422 | dữ liệu không hợp lệ (`invalid_input`, thiếu trường bắt buộc) |
  | 500 | lỗi hệ thống ngoài dự kiến |
- **Phân trang:** `page` (≥1), `pageSize` (mặc định 50, tối đa 200 trừ khi route nói khác). `page` không hợp lệ (không phải số nguyên an toàn trong khoảng 1–100.000) tự về `1`.
- **Id trong đường dẫn:** mọi tham số tên `id`/`...Id` được kiểm dạng UUID ở lớp `api()` trước khi vào handler — sai dạng trả `404`, không chạy SQL. Một số route còn kiểm thêm ở tầng service (`assertUuid`) để giữ hành vi nhất quán khi id đến từ nơi khác handler chính (ví dụ id lồng trong body).
- **`expectedVersion`/`expectedUpdatedAt`:** nhiều thao tác ghi yêu cầu gửi phiên bản đang xem; lệch với DB → `409 stale_version`. Đây là cơ chế optimistic locking, dùng cùng với `router.refresh()` phía client.

## Xác thực

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| POST | `/api/v1/auth/login` | công khai | `{ email, password }`; khoá tạm sau 5 lần sai |
| POST | `/api/v1/auth/logout` | đã đăng nhập | xoá phiên hiện tại |

## Booking

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/bookings` | `booking.view` | filter: `from,to,property,unit,channel,status,stay,pending=1,conflict=1,q,sort,page,pageSize`; `sort` qua whitelist `BOOKING_SORTS` |
| POST | `/bookings` | `booking.create` | body `createBookingInput`; `409 inventory_conflict` kèm `details.conflicts` |
| GET | `/bookings/export` | `booking.view` | cùng bộ lọc GET list → file `.xlsx`; cột Khách/SĐT và Tiền bị ẩn theo quyền (`booking.view_guest_contact`, `revenue.view`) |
| GET | `/bookings/:id` | `booking.view` | chi tiết + `changes[]` (lịch sử) |
| PATCH | `/bookings/:id` | `booking.edit` | chỉ sửa thông tin không ảnh hưởng tồn phòng; bắt buộc `expectedVersion` |
| GET | `/bookings/:id/change-requests` | `booking.view` | |
| POST | `/bookings/:id/change-requests` | `booking.request_change` (thêm `booking.approve_change` nếu `applyNow: true`) | body `{ change: ChangeRequestPayload, note?, applyNow? }` |
| POST | `/bookings/:id/stay-status` | `booking.stay_status` | `{ status: "checked_in"\|"checked_out"\|"no_show"\|"expected", expectedVersion, at? }` |

## Yêu cầu thay đổi (change requests)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/change-requests` | `booking.view` | `?status=pending\|applied\|rejected\|superseded\|failed` |
| POST | `/change-requests/:id/apply` | `booking.approve_change` | `{ note? }`; `409` nếu kiểm tra lại không đạt (`details.issues`); trả `{ superseded: true }` nếu booking đã đổi phiên bản từ lúc tạo yêu cầu |
| POST | `/change-requests/:id/reject` | `booking.approve_change` | `{ note }` bắt buộc — `422` nếu trống |

## Xung đột tồn phòng

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/conflicts` | `booking.view` | `?status=open\|resolved` |
| POST | `/conflicts/:id/resolve` | `conflict.resolve` | `{ resolution }` — ghi chú cách xử lý, không tự hủy booking nào; `422` nếu trống |

## Tồn phòng và lịch

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/availability` | một trong `booking.create`, `booking.request_change`, `calendar.view`, `booking.view` | `?unitId&start&end[&excludeBookingId]` → `{ available, conflicts[] }`, chỉ đọc |
| GET | `/calendar` | `calendar.view` | `?start=YYYY-MM-DD&days=1\|7\|14&property=<uuid>` |
| GET | `/inventory-blocks` | `calendar.view` | `?from=YYYY-MM-DD&unitId=` — chặn tồn đang hiệu lực |
| POST | `/inventory-blocks` | `inventory.block` | `{ unitId, startDate, endDate, reason }` — `409 inventory_conflict` kèm `details.conflicts` |
| DELETE | `/inventory-blocks/:id` | `inventory.block` | gỡ chặn, giải phóng tài nguyên, ghi audit `inventory.unblock` |

## Danh mục (catalog)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/catalog` | `catalog.view` | nhà, tài nguyên, sản phẩm (kèm `resource_ids`), listing theo kênh, danh sách cần xác nhận |
| PATCH | `/catalog/properties/:id` | `catalog.edit` | `{ expectedUpdatedAt?, dataStatus?, dataNote?, defaultCleanMinutes? }` |
| PATCH | `/catalog/units/:id` | `catalog.edit` | `{ expectedUpdatedAt?, dataStatus?, dataNote?, capacity?, active?, cleanMinutes? }` |
| PATCH | `/catalog/listings/:id` | `catalog.edit` | `{ expectedUpdatedAt?, status?, dataStatus?, dataNote? }` |

## Cleaning (điều phối)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/cleaning/tasks` | `cleaning.view_all` | `?date=YYYY-MM-DD&status=&propertyId=` — việc của một ngày vận hành (mặc định hôm nay theo giờ tổ chức); **chưa phân trang thật**, `pageSize = items.length` |
| GET | `/cleaning/tasks/:id` | `cleaning.view_all`/`cleaning.manage`, hoặc chính cleaner được giao | việc người khác trả `404` với cleaner |
| GET | `/cleaning/tasks/:id/suggestions` | `cleaning.manage` | gợi ý cleaner (điểm + lý do) — không tự giao |
| POST | `/cleaning/tasks/:id/assign` | `cleaning.manage` | `{ userId, expectedVersion? }` |
| POST | `/cleaning/tasks/:id/unassign` | `cleaning.manage` | `{ reason }` |
| POST | `/cleaning/tasks/:id/cancel` | `cleaning.manage` | `{ reason }` bắt buộc; nếu việc đang `in_progress`/`awaiting_inspection`, phòng trả về `vacated_dirty` |
| POST | `/cleaning/tasks/:id/confirm-vacated` | `cleaning.manage` | `{ note }` bắt buộc — chỉ khi việc `pending_assignment\|assigned\|accepted` và đã tới ngày trả phòng (`409 service_date_in_future` nếu chưa tới) |
| POST | `/cleaning/incidents/:id/resolve` | `cleaning.manage` | `{ note }`; chỉ đổi readiness phòng khi sự cố vừa đóng có `severity='blocking'` |
| GET | `/cleaning/my-tasks` | `cleaning.own` | việc giao cho người đang đăng nhập |
| POST | `/cleaning/tasks/:id/accept` | `cleaning.own`, đúng người được giao | `{ expectedVersion? }` |
| POST | `/cleaning/tasks/:id/decline` | `cleaning.own`, đúng người được giao | `{ reason }` bắt buộc |
| POST | `/cleaning/tasks/:id/start` | `cleaning.own`, đúng người được giao | chặn nếu `change_ack_required` (`409`) hoặc khách chưa được xác nhận rời phòng (`409 guest_not_confirmed_out`) |
| PATCH | `/cleaning/tasks/:id/checklist/:itemId` | `cleaning.own`, đúng người được giao | `{ checked, note? }`; chỉ khi `in_progress` và không còn thay đổi chờ xác nhận |
| POST | `/cleaning/tasks/:id/finish` | `cleaning.own`, đúng người được giao | `422 checklist_incomplete` nếu còn mục chưa tích; chặn nếu còn thay đổi chờ xác nhận |
| POST | `/cleaning/tasks/:id/ack-change` | chính cleaner được giao | xác nhận thay đổi (đổi lịch, hoặc hủy dọn) |
| POST | `/cleaning/tasks/:id/inspect` | `readiness.approve` | `{ result: "pass"\|"fail", note?, expectedVersion? }`; `fail` → tích lại checklist từ đầu, trạng thái `needs_reclean`; `pass` chặn nếu còn checklist chưa tích hoặc sự cố `blocking` chưa xử lý |
| POST | `/cleaning/tasks/:id/incidents` | cleaner được giao hoặc `cleaning.manage` | `{ kind, severity, description }` |

Toàn bộ nhóm `/cleaning/tasks/:id/*` trả `404` (không phải `403`) khi cleaner gọi việc không phải của mình, để không lộ việc đó tồn tại.

## Kết nối kênh (connectors)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/connectors` | `connector.view` | trạng thái 5 mức (`not_configured\|demo\|testing\|active\|error`), năng lực, lần thử/thành công gần nhất, lỗi, tạm dừng |
| GET | `/connectors/events` | `connector.view` | `?connectorId=&status=&page=&pageSize=` — nhật ký sự kiện nhận, kèm độ trễ nhận→xử lý |
| POST | `/connectors/:id/pause` | `connector.manage` hoặc `automation.pause` | `{ paused, reason? }` — lý do bắt buộc khi tạm dừng (≥3 ký tự); `409 no_change` nếu trạng thái không đổi. Logic nằm ở `src/modules/connectors/service.ts` (tách khỏi `queries.ts`, vốn giờ chỉ đọc) |
| POST | `/connectors/:id/demo` | `connector.manage`/`automation.pause` | chỉ chạy trên connector `status='demo'` — `409 not_demo_connector` nếu không; mô phỏng sự kiện để test luồng, không phải kết nối thật |

## Nhập Excel/docx (imports)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| POST | `/imports/inspect` | `import.preview` | multipart `file` → danh sách sheet (tiêu đề dòng nào, có phải bảng booking không); không lưu gì; sheet Hủy không được liệt kê để chọn làm nguồn |
| POST | `/imports` | `import.preview` | multipart `file`, `sheet?` (mặc định `TH`) → tạo lô xem trước (`import_batches` + `import_rows`); `409 file_already_applied` nếu file (theo sha256) đã áp dụng; `422 cancel_sheet_as_source` nếu chọn sheet Hủy làm nguồn |
| GET | `/imports` | `import.preview` | `?page&pageSize` — các lô đã nhập |
| GET | `/imports/:batchId` | `import.preview` | chi tiết lô |
| GET | `/imports/:batchId/rows` | `import.preview` | `?disposition&issue&sheet&page&pageSize`; Khách/SĐT hiện `[ẩn]` nếu thiếu `booking.view_guest_contact`; cột ghi chú/khoản thu (`paymentNote`) hiện `[ẩn khoản thu]` nếu thiếu `revenue.view` |
| POST | `/imports/:batchId/apply` | `import.apply` | `{ skipCheckOutBefore?: "YYYY-MM-DD" }` — mỗi dòng `ready` được "nhận" (`SELECT … FOR UPDATE WHERE disposition='ready'`) và đổi disposition trong cùng giao dịch với booking, chống hai lượt apply cùng lúc tạo dữ liệu sai; `409 file_already_applied\|batch_already_applied\|batch_discarded\|batch_applying\|no_ready_rows` |
| POST | `/imports/:batchId/discard` | **`import.apply`** | chỉ lô còn `previewed`, giữ lại dòng để truy vết; `409` nếu đang có lượt apply chạy đua và thắng trước |
| POST | `/imports/aliases` | `catalog.edit` | tạo alias tên căn/phòng từ tên sản phẩm nội bộ; không ghi đè alias đang trỏ sản phẩm khác |

File upload: phải là `.xlsx` (kiểm chữ ký zip thật, không chỉ đuôi file), ≤ 15 MB.

**Mã lý do dòng nhập đáng chú ý** (đầy đủ ở `src/modules/imports/excel/issues.ts`): `listed_in_cancel_sheet` (mã cũng có ở sheet Hủy → chặn, không tự coi là còn hiệu lực hay đã hủy), `payment_note` (ghi chú Excel có khoản thu, đã tách khỏi `channel_note`, cảnh báo — không chặn), `cancel_sheet` (dòng nằm trong sheet Hủy — luôn vào hàng kiểm tra), `past_stay_skipped` (bỏ qua khi áp dụng vì trả phòng trước mốc `skipCheckOutBefore` đã chọn).

## Nhật ký

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/audit` | `audit.view` | `?entityType=&action=&actor=<uuid\|system:connector>&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&pageSize=` (ngày theo giờ Budapest); ẩn liên hệ khách theo quyền (`redactGuest`) |

## Chưa có

Không có route nào cho: ảnh/QC AI, Inbox hội thoại, kho Q&A, Agent Center, báo cáo, đặt phòng trực tiếp/thanh toán, thoại/WhatsApp/Viber. Xem `docs/TRUY-VET-YEU-CAU.md`.
