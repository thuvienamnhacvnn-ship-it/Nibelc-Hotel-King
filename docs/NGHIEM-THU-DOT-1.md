# Nghiệm thu Đợt 1 — kịch bản bấm tay

Chạy sau khi `npm run db:dev` + `npm run db:migrate` + `npm run db:seed` + `npm run dev` + `npm run worker` đều đang chạy (xem `README.md`). Mật khẩu chung DEMO: `Demo-Nibelc-2026`.

**Lưu ý về ngày:** dữ liệu DEMO được gieo (`npm run db:seed`) tính ngày "hôm nay" tại **thời điểm chạy lệnh seed**, không tự cập nhật sau đó. Nếu nghiệm thu cách xa ngày seed vài hôm, các mô tả "hôm nay/hôm qua/mai" trong danh sách booking DEMO bên dưới đã lệch — hãy đọc ngày thật hiển thị trên màn hình thay vì tin vào mô tả tương đối. Các kịch bản 3–6 dùng trạng thái không phụ thuộc ngày (đã hủy, đang chờ duyệt, đang mở) nên không bị ảnh hưởng.

## 1. Quay vòng phòng trong ngày (turnover)

Mục tiêu: một phòng vừa trả khách trong ngày phải tự sinh việc dọn, và việc đó chặn khách mới vào ở tới khi dọn xong + Budapest Team duyệt sẵn sàng.

1. Đăng nhập `diu@demo.nibelc.local`. Vào **Booking** → **Tạo booking mới**: chọn một phòng lẻ bất kỳ (ví dụ `A001`), ngày nhận = hôm nay, ngày trả = hôm nay + 1 (hoặc chọn ngày trả = hôm nay nếu muốn kiểm ngay). Lưu.
2. Đặt `stay_status` của booking vừa tạo thành **Đã trả phòng** (nút trên trang chi tiết booking, hoặc qua `/bookings/:id`).
3. Đợi vài giây cho worker chạy (terminal `npm run worker` in log `[worker] xong ...`), hoặc bấm refresh trang **Cleaning**.
4. Đăng nhập `thao@demo.nibelc.local` → **Cleaning**: phải thấy một việc dọn mới cho đúng phòng đó, hạn hoàn thành trong ngày, trạng thái "Chờ phân công".
5. Giao việc cho `cleaner.a@demo.nibelc.local`.
6. Đăng nhập `cleaner.a` trên điện thoại (`/m` — thu nhỏ trình duyệt hoặc dùng thiết bị thật): thấy việc mới, bấm **Nhận việc** → **Bắt đầu**. Nếu hệ thống báo "chưa xác nhận khách rời phòng", quay lại bước thao@ và bấm **Xác nhận khách đã rời** trên phòng đó trước, rồi thử lại.
7. Tích đủ checklist → **Hoàn thành**.
8. Đăng nhập `thao@` (hoặc `budapest@`) → mở việc đó → **Kiểm phòng** → chọn Đạt. Kỳ vọng: phòng chuyển trạng thái "Sẵn sàng".

## 2. Đổi phòng giữa kỳ ở

1. Đăng nhập `diu@demo.nibelc.local` → **Booking**, mở một booking đang hoạt động (`booking_status = confirmed`, chưa checkout) đặt một phòng lẻ, ví dụ booking mã `DEMO-HM1009` (phòng `A001`).
2. Trên trang chi tiết, chọn **Yêu cầu thay đổi** → **Đổi phòng**, chọn phòng khác còn trống (ví dụ `A002` hoặc `A003`, kiểm không trùng lịch), ngày hiệu lực = một ngày trong kỳ ở. Không tick "Áp dụng ngay" — lưu.
3. Vào **Duyệt** (`/duyet`): thấy yêu cầu "pending". Booking gốc vẫn giữ phòng cũ (đây là ca kiểm thử bắt buộc "khách xin đổi ngày/phòng nhưng chưa duyệt" — booking hiện hành không đổi).
4. Bấm **Áp dụng**. Kỳ vọng: booking có 2 dòng phân bổ (lịch sử phòng cũ + phòng mới), lịch phòng (`/lich`) hiện đúng khoảng ngày cho từng phòng, và một việc kiểm/dọn mới sinh cho phòng mới (xem worker log).
5. Thử đổi sang một phòng đang có khách khác ở cùng ngày → kỳ vọng hệ thống báo lỗi tồn phòng (`409`), không cho áp dụng.

## 3. Gia hạn khi cleaner đã nhận việc

1. Trước tiên tạo trạng thái "đã nhận việc": đăng nhập `diu@` tạo booking mới ở một phòng, ngày nhận = hôm nay − 1, ngày trả = hôm nay. Đặt `stay_status = checked_out`. Đợi worker sinh việc dọn.
2. Đăng nhập `thao@` → giao việc đó cho `cleaner.b@demo.nibelc.local`. Đăng nhập `cleaner.b` → **Nhận việc** (không bấm Bắt đầu).
3. Đăng nhập `diu@` → mở lại booking đó → **Yêu cầu thay đổi** → **Đổi ngày**, kéo dài ngày trả thêm 1–2 ngày, tick **Áp dụng ngay** (`applyNow`, cần quyền `booking.approve_change` — `diu@` có).
4. Đăng nhập `cleaner.b` (hoặc `thao@`): việc dọn đó phải hiện badge **"Có thay đổi cần xác nhận"** và các nút thao tác (tích checklist, hoàn thành) bị chặn cho tới khi bấm **Xác nhận thay đổi**. Đây là ca kiểm thử bắt buộc — không được để cleaner âm thầm tiếp tục dọn theo hạn cũ.
5. Bấm **Xác nhận thay đổi**. Kỳ vọng: nút thao tác mở lại, hạn hoàn thành/ngày dọn đã cập nhật theo booking mới.

## 4. Xung đột kênh (hai nguồn cùng bán một đêm)

Dùng dữ liệu DEMO sẵn có — không phụ thuộc ngày:

1. Đăng nhập `diu@` hoặc `ngoc@demo.nibelc.local` → mở **Booking**, lọc theo "có xung đột" hoặc vào thẳng trang chi tiết booking `DEMO-HM1012`. Đây là sự kiện do connector DEMO gửi, trùng đêm với một booking khác trên cùng phòng.
2. Kỳ vọng: hệ thống **không** tự huỷ booking nào, cả hai vẫn tồn tại, và có một mục "xung đột đang mở" liệt kê ở trang duyệt/xung đột.
3. Đọc kỹ hai booking liên quan, chọn giữ booking nào, sau đó **Giải quyết xung đột**: ghi rõ lý do xử lý (ví dụ: "Đã xác nhận với khách A, huỷ khách B qua Airbnb"). Kỳ vọng: mục xung đột chuyển "đã xử lý", không có booking nào tự đổi trạng thái — người dùng phải tự làm bước huỷ/giữ tương ứng riêng nếu cần.

## 5. Nhập Excel lặp

1. Đăng nhập `diu@` → **Nhập Excel** → tải lên `fixtures/demo-lich-dat-phong.xlsx` → chọn sheet "TH" → **Xem trước**.
2. Vào trang lô vừa tạo, xem bảng "hướng xử lý" (ready/cần kiểm/trùng trong file/chỉ ở sheet nhà) và bảng lý do.
3. Bấm **Áp dụng N dòng hợp lệ** (giữ tick mặc định "chỉ nhập booking có ngày trả phòng từ hôm nay" trừ khi có lý do khác). Kỳ vọng: số dòng áp dụng khớp số `ready`, các booking mới xuất hiện ở `/bookings` mang nhãn DEMO.
4. Tải lên **lại đúng file đó** lần thứ hai. Kỳ vọng: hệ thống báo `409` "file đã áp dụng" ngay ở bước tải lên hoặc ở bước Xem trước — **không** tạo booking trùng lần hai. Kiểm bằng cách đếm số booking mang mã đặt phòng giống lô đầu ở `/bookings` (phải không đổi so với sau bước 3).
5. Mở một dòng có lý do "trùng mã trong file" hoặc "đã có trong hệ thống" — xác nhận dòng đó **không** bị xoá khỏi bảng, chỉ đứng ở trạng thái tương ứng để người kiểm tra tay.

## 6. Phân quyền cleaner

1. Đăng nhập `cleaner.a@demo.nibelc.local` trên `/m`. Kỳ vọng: chỉ thấy việc được giao cho mình, không thấy tên/số điện thoại khách, không thấy số tiền booking, không có menu Booking/Danh mục/Kết nối.
2. Thử vào thẳng URL `/cleaning` hoặc `/bookings` bằng `cleaner.a` → kỳ vọng bị chuyển về trang "Không đủ quyền".
3. Lấy id của một việc dọn **không** giao cho `cleaner.a` (ví dụ việc giao cho `cleaner.b`), thử mở `/m/viec/<id đó>` bằng `cleaner.a` → kỳ vọng hiện trang "không tìm thấy", không lộ dữ liệu phòng/khách của việc đó.
4. Đăng nhập `budapest@demo.nibelc.local` (Budapest Team, không phải điều phối) → vào **Cleaning**: kỳ vọng thấy toàn bộ lịch điều phối ở chế độ chỉ xem (không có nút giao việc/huỷ việc), có thể duyệt phòng sẵn sàng và xác nhận khách rời phòng theo quyết định đã chốt (xem `QUYET-DINH-CAN-CHOT.md` mục 11 — tại thời điểm viết tài liệu, "Xác nhận khách đã rời" chỉ dành cho `thao@`/điều phối, không phải `budapest@`).
5. Đăng nhập `ngoc@demo.nibelc.local` (chỉ xem báo cáo) → kỳ vọng thấy được số tiền trên booking (`revenue.view`) nhưng **không** thấy tên/SĐT khách; xuất Excel (`/bookings` → Xuất) chỉ có cột Số tiền, không có cột Khách/SĐT.
