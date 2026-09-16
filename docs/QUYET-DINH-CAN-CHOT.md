# Quyết định cần chốt

Tổng hợp từ đặc tả (báo cáo kiểm thử nội bộ mục 6), `src/modules/booking/rules.ts`, `src/modules/auth/permissions.ts`, và các điểm QA/import-engineer gắn cờ "cần xác nhận" trên dữ liệu thật. Hệ thống đang chạy ở trạng thái an toàn mặc định (chưa thu phí, chưa gộp dữ liệu mơ hồ) cho tới khi có quyết định — không hành động nào bị chặn vì thiếu các mục dưới đây.

## Dịu (Vietnam Team — booking, danh mục, dữ liệu)

1. **Mapping mã 6501**: tên listing Airbnb ghi "for 4" nhưng sức chứa khai báo là 2. Trong Excel thật, 112 dòng đặt mã 6501 có 3–4 khách → hệ thống đang chặn các dòng này (`capacity_exceeded`), không tự nhập. Cần Dịu xác nhận sức chứa đúng là bao nhiêu.
2. **Quan hệ 6500/6503**: chưa rõ Studio 6503 có nằm trong nguyên căn 6500 hay là tài nguyên riêng. Hệ thống đang không gắn hai mã này với nhau (`unit_resources` để trống quan hệ này) — cần Dịu xác nhận trước khi khai báo, vì đặt phòng lẻ chặn sai nguyên căn (hoặc ngược lại) sẽ gây double-booking hoặc chặn nhầm.
3. **Mã 5901 (Airbnb)**: ghi "Đang bị khóa bởi nền tảng". Hệ thống lưu trạng thái theo từng kênh (`channel_listings.status`), không tự khóa cả sản phẩm ở mọi kênh — cần Dịu xác nhận tình trạng hiện tại (còn khóa không) trước khi nhập.
4. **Mã 5000**: chi tiết giường ghi 8 phòng nhưng chỉ 7 phòng lẻ được khai báo trong docx danh mục. Cần Dịu xác nhận phòng thứ 8 hay số 8 là nhầm.
5. **6 nhà có trong Excel lịch đặt phòng nhưng không có trong docx danh mục**: Kerepesi 1, Ferenc, Hogyes, Rakoczi 51, Jozsef 28, Jozsef 69. Cần Dịu xác nhận các nhà này còn hoạt động không — nếu còn, cần bổ sung vào danh mục trước khi nhập lịch sử của chúng; nếu đã dừng, giữ nguyên trạng thái `needs_confirmation`/không tạo.
6. **Tên phòng chưa có alias trỏ về mã chuẩn nào**, xuất hiện nhiều lần trong Excel thật: `Family J18` (17 dòng), `Balcony Home J65 Sweet` / "Sweet Home Balcony J65" (5 dòng), cùng một loạt tên thuộc các nhà lịch sử ở mục 5 (`clever ke1 pirate`, `ke1 princess`, `apartment ferenc`...). Cần Dịu xác nhận từng tên trỏ về mã sản phẩm nào (hoặc xác nhận là nhà đã dừng, không cần alias) — hệ thống không tự đoán theo tên gần giống.
7. **Booking.com property/room ID**: 44/44 listing Booking.com trong docx chỉ có link chia sẻ (share link), không có `external_listing_id`/`external_room_id` thật — không đủ để tích hợp API thật sau này. Cần Dịu lấy ID thật từ extranet Booking.com cho từng phòng.
8. **Mapping tài khoản theo listing**: bảng tổng "MAPPING KÊNH BÁN" (24 email tài khoản, 97 dòng mapping) có điểm chưa thống nhất giữa bảng tổng và phần mô tả từng nhà — import-engineer mới đọc phần mô tả từng nhà. Cần Dịu xác nhận bảng nào là đúng trước khi nhập.
9. **Đổi mật khẩu OTA đã lộ**: file nguồn docx từng chứa mật khẩu ở dạng chữ thường lẫn trong đoạn text tài khoản. Không có mật khẩu nào bị đưa vào code/DB/fixture (đã kiểm bằng script trích email, 0 chuỗi lộ trên dữ liệu thật) — nhưng file nguồn vẫn cần **đổi mật khẩu đã từng chia sẻ** và chuyển sang kho bí mật, việc này ngoài phạm vi phần mềm.
10. **Chuyển đổi mã ngày Excel bị đảo**: 1.352/1.352 ô kiểu Date trong sheet TH có ngày ≤ 12 (không phân biệt được dd/mm hay mm/dd chỉ từ số), và so khớp 398/500 ô "ngày nhận booking sau ngày nhận phòng" sẽ hợp lý nếu đảo ngày/tháng — gần như chắc Excel đã đảo các ô này khi nhập liệu. Hệ thống chỉ gắn cờ (`booked_date_cell_ambiguous`), không tự đảo, và không ghi `booking_created_at` khi mơ hồ. Cần Dịu xác nhận cách đọc đúng (có thể theo từng khoảng thời gian nhập liệu) trước khi coi các ô này là dữ liệu tin cậy.

## Thảo / Budapest Team (cleaning, vận hành hiện trường)

11. **Ai được xác nhận "khách đã rời phòng"?** Đặc tả ghi Budapest Team chỉ điều phối và xác nhận sẵn sàng; QA phát hiện quyền gốc cho cả `vn_staff`/`bp_staff` gọi được API này (lỗ hổng C2, đã sửa). Hiện tại `POST /cleaning/tasks/:id/confirm-vacated` **chỉ nhận `cleaning.manage`**, tức là vai trò `bp_coordinator` (Thảo) — người khác không gọi được. Cần Thảo/Dịu xác nhận đây đúng là quyết định muốn giữ, hay cần mở thêm cho vai trò khác.
12. **Danh sách cleaner, ca làm, thời lượng dọn thật**: chưa nhận được. Dữ liệu DEMO có 3 cleaner mẫu (`cleaner.a/b/c`) và thời lượng dọn mặc định (`default_clean_minutes = 90`). Danh sách A/B/C nhắc trong tin nhắn nguồn chỉ là ví dụ minh họa, không phải hồ sơ cleaner thật.
13. **Ảnh mẫu đạt/chưa đạt, checklist khu riêng/khu chung, vật tư, người kiểm phòng, đầu mối sửa chữa, người trực thay Thảo**: chưa có — cần cho Đợt 2 (ảnh/QC).

## Ngọc / Dịu (báo cáo, doanh thu, phê duyệt tài chính)

14. **`vn_staff` có được xem doanh thu không?** Đang **tắt** (`vn_staff` không có `revenue.view` trong `permissions.ts`). Ảnh hưởng cụ thể: (a) hoa@ (vn_staff) xem trước Excel thấy được cột "khoản thu" trong ghi chú (ghi chú G3 của QA imports — vì cột này hiện diện độc lập với `revenue.view`, cần rà lại khi chốt); (b) export Excel ẩn cột Số tiền với vai trò này. Cần Dịu xác nhận đúng ý muốn hay cần bật.
15. **Phí vệ sinh (20€ phòng lẻ / 30€ nguyên căn), phụ thu nhận sớm/trả muộn (20/30/35€), giảm giá tuần/tháng (10%/15%)**: đã khai báo trong `src/modules/booking/rules.ts` nhưng **tất cả `active: false`** — không cộng vào booking nào. Câu hỏi cần chốt cho từng khoản (đúng nguyên văn trong code, `pendingQuestion`):
    - Phí vệ sinh: đã nằm trong giá OTA hay thu riêng? Tính mỗi kỳ ở hay mỗi lần dọn?
    - Phụ thu sớm/muộn: khách dùng cả hai thì thu một hay hai lần?
    - Giảm giá tuần/tháng: số đêm tối thiểu là bao nhiêu? Thứ tự áp dụng giữa hai loại? Có cộng dồn với khuyến mại OTA không?
16. **Lịch báo cáo 08:00/20:00 giờ Budapest**: chỉ là đề xuất trong đặc tả, **chưa cấu hình, chưa có màn hình báo cáo, chưa gửi cho ai**. Cần Ngọc/Dịu chốt giờ/kênh nhận trước khi làm Đợt 3.
17. **"Booking hoàn tối đa 100 EUR"** ghi trong tài liệu nội bộ chưa rõ là khoản bồi thường nào — đặc tả nói rõ **không được coi là giới hạn chung của nền tảng**. Cần Dịu làm rõ trước khi đưa vào bất kỳ quy tắc hoàn tiền nào.
18. **Thời điểm OTA thực trả tiền**: cần đối soát theo tài khoản/giao dịch thật, không hard-code "mọi đơn trả sau check-out".

## Chủ hệ thống (Sếp) — hạ tầng, pháp lý, kết nối

19. **Booking.com Connectivity API**: cổng đăng ký đối tác mới hiện thông báo tạm dừng (theo kiểm tra tài liệu công khai ngày 16/09/2026, `[W1][W2]` trong đặc tả). API chính thức (Connectivity API) chỉ mở cho đối tác đã được Booking.com chứng nhận (certified partner/connectivity provider) — NIBELC hiện không phải đối tác dạng này, nên không thể tích hợp API trực tiếp cho tới khi có chứng nhận đó hoặc cổng đăng ký mở lại.
    - **Đề xuất bước thử trước khi có API** (mức tối thiểu, không cần đăng nhập extranet thay chủ hệ thống): (a) lấy **link iCal xuất lịch của một phòng** từ extranet Booking.com/Airbnb (chỉ đọc, chỉ cho biết bận/trống theo chu kỳ làm mới của từng kênh — Airbnb khoảng 3 giờ) để thử đồng bộ tồn phòng một chiều; hoặc (b) đọc **email xác nhận booking mẫu** (ẩn danh, không có tên/SĐT khách thật) để thử luồng nhận dữ liệu có cấu trúc từ một nguồn không phải API.
    - Cả hai cách trên **không đủ** cho tên khách, số khách, tin nhắn hay realtime (đúng giới hạn đặc tả nêu) — chỉ dùng để chứng minh cơ chế nhận sự kiện → cập nhật bảng vận hành chạy được, trước khi xin quyền API thật.
    - Không đăng nhập bằng mật khẩu hộ chủ hệ thống vào extranet — cần chủ hệ thống xác nhận cách nào khả thi (lấy link iCal, hay cấp hộp thư nhận email xác nhận riêng) và cấp quyền tương ứng.
20. **WhatsApp Cloud API Calling / Viber voice**: chưa có bằng chứng khả dụng trên tài khoản NIBELC — đặc tả yêu cầu kiểm tra eligibility của số/tài khoản trước khi cam kết. Cần chủ hệ thống xác nhận số hotline, tài khoản WhatsApp Business, và quyền Viber bot thương mại.
21. **Đơn vị nhận tiền cho kênh đặt trực tiếp**: đặc tả nêu dự kiến là Công ty Cổ phần Khách sạn Du lịch Hoàng Long — đây là yêu cầu kinh doanh, **chưa chứng minh cổng thanh toán và cấu trúc thanh toán đã được duyệt**. Cần chốt trước khi xây connector thanh toán (Đợt 4 trở đi).
22. **Production/VPS**: chưa có; xem `TRIEN-KHAI-VA-SAO-LUU.md`. Cần chủ hệ thống cấp VPS/PostgreSQL thật và xác nhận phạm vi nhà pilot trước khi đưa dữ liệu thật vào.

## Chưa cấu hình vì chưa được chốt (không chặn Đợt 1)

- Toàn bộ 6 mục ở đặc tả nói "cần chốt trước khi bật tự động rộng hơn" (QC ảnh tự duyệt, đặt phòng trực tiếp, connector thật, báo cáo tự động) — không có nút nào cho các mục này ở Đợt 1, nên không có rủi ro bật nhầm.
