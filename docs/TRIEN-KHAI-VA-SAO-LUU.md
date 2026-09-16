# Triển khai và sao lưu

**Trạng thái: đây là đề xuất kiến trúc, chưa phải việc đã làm.** Chưa có VPS cho NIBELC Platform, chưa chạy lệnh deploy nào, chưa diễn tập backup/restore thật. Mọi con số RPO/RTO dưới đây là đề xuất chưa được đội vận hành duyệt.

## Khác biệt dev/production

Máy dev (Windows của Sếp) dùng **PGlite** (PostgreSQL biên dịch WASM, chạy trong một tiến trình Node) thay vì PostgreSQL thật, vì Smart App Control trên máy chặn cài đặt .exe của PostgreSQL. Cầu nối là `scripts/pglite-server.ts`, bọc PGlite sau giao thức mạng Postgres để `pg` (thư viện client thật) kết nối như tới Postgres bình thường — cùng migration chạy được ở cả hai nơi. Điều này **không** có nghĩa production dùng PGlite: production phải là PostgreSQL thật.

Hệ quả cần biết trước khi lên production:

- **Test tranh chấp đồng thời** (`tests/inventory.test.ts`, phần race của `tests/imports.test.ts`) chạy trên PGlite trong CI/dev. PGlite tuần tự hoá giao dịch bên trong một tiến trình, nên **không đo được hành vi khoá thật dưới tải song song của PostgreSQL đa kết nối**. Bắt buộc chạy lại các test này trỏ vào một PostgreSQL staging thật trước khi tin cậy cơ chế chống tranh chấp tài nguyên (`resource_claims_no_overlap` EXCLUDE) ở production.
- PGlite dev từng lộ lỗi "lệch giao thức" khi một câu lệnh có tham số bị lỗi (ghi trong báo cáo kiểm thử nội bộ, đã vá bằng cầu nối socket riêng ở commit `457a5ba`) — dấu hiệu là 401/404/500 thoáng qua không tương ứng với request. Chưa có bằng chứng lỗi này xảy ra trên PostgreSQL thật; vẫn nên theo dõi log lỗi lạ trong tuần đầu chạy production.
- `DB_POOL_MAX` mặc định 8 kết nối (`src/lib/db.ts`) — hợp lý cho PostgreSQL thật, quá nhiều cho PGlite (PGlite dev nên coi như một kết nối).

## Kiến trúc đề xuất

```
VPS
 ├─ nginx (reverse proxy, HTTPS, gộp domain)
 ├─ Next.js (npm run build && npm run start) — cổng nội bộ, không public trực tiếp
 ├─ worker (npm run worker) — tiến trình riêng, xử lý outbox
 ├─ PostgreSQL thật (không PGlite) — cài trực tiếp hoặc container tách biệt
 └─ backup: pg_dump định kỳ ra thư mục/đối tượng lưu trữ riêng khỏi VPS chạy DB
```

Modular monolith một web app + một worker, không tách microservice ở giai đoạn này (đúng lựa chọn kiến trúc ban đầu trong báo cáo kiểm thử nội bộ).

## Biến môi trường (production)

Dựa trên `.env.example` — không đặt bí mật thật vào file trong repo:

| Biến | Ý nghĩa | Ghi chú production |
|---|---|---|
| `DATABASE_URL` | chuỗi kết nối PostgreSQL | trỏ tới PostgreSQL thật, không phải PGlite |
| `COOKIE_SECURE` | `1` khi chạy sau HTTPS | **bắt buộc `1`** ở production, nginx phải terminate TLS |
| `DEFAULT_TIMEZONE` | múi giờ mặc định tổ chức mới | `Europe/Budapest` |
| `UPLOAD_DIR` | thư mục ảnh tải lên (Đợt 2, chưa dùng ở Đợt 1) | đặt ngoài `public/`, có backup riêng khi Đợt 2 triển khai |
| `DB_POOL_MAX` | số kết nối pool (mặc định 8) | tính theo `max_connections` của PostgreSQL và số tiến trình (web + worker) |
| `WORKER_POLL_MS` | nhịp poll outbox của worker (mặc định 2000ms) | giữ mặc định trừ khi có lý do |

## Quy trình migrate/build (đề xuất, chưa chạy thật ngoài dev)

```bash
npm ci
npm run db:migrate   # áp migrations/*.sql chưa áp; bảng schema_migrations chặn sửa file đã áp
npm run build
npm run start         # hoặc chạy qua pm2/systemd, xem mẫu dưới
npm run worker         # tiến trình riêng, cũng nên có supervisor
```

### Mẫu systemd (đề xuất, chưa triển khai)

```ini
# /etc/systemd/system/nibelc-web.service
[Unit]
Description=NIBELC Platform — web
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/nibelc-platform
EnvironmentFile=/opt/nibelc-platform/.env.production
ExecStart=/usr/bin/npm run start
Restart=on-failure
User=nibelc

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/nibelc-worker.service — giống trên, ExecStart=npm run worker
```

Web vẫn phục vụ được khi worker dừng (việc dọn chỉ chậm cập nhật) — không đặt `Requires=` giữa hai service.

## Backup và khôi phục (đề xuất, chưa diễn tập)

- **Sao lưu định kỳ**: `pg_dump` toàn bộ database, nén, đẩy ra khỏi VPS chạy DB (đối tượng lưu trữ riêng hoặc VPS khác). Tần suất đề xuất: hằng ngày, giữ 14 bản gần nhất — đây là đề xuất, cần Sếp/đội vận hành chốt tần suất và nơi lưu thật.
- **Khôi phục thử (restore drill)**: `pg_restore` vào một database rỗng riêng, chạy `npm run db:migrate` để xác nhận không lệch schema, đối chiếu vài số liệu (số booking, số phòng) với báo cáo gần nhất. **Chưa từng chạy** — bắt buộc làm trước khi coi backup là đáng tin, không chỉ tin vào việc file dump được tạo ra.
- **RPO/RTO đề xuất** (chưa cam kết): RPO 24h (theo tần suất backup hằng ngày), RTO vài giờ (thời gian dựng lại VPS + restore + kiểm tra thủ công). Cần đội vận hành xác nhận mức độ chấp nhận được — nếu cần RPO ngắn hơn, phải đổi sang backup liên tục (WAL archiving) thay vì `pg_dump` định kỳ.
- **Không sao lưu bí mật cùng chỗ với dump dữ liệu**: mật khẩu OTA, khóa cửa không nằm trong database này (đúng theo quy tắc "không đưa mật khẩu/mã cửa vào code/DB/log" — xem `QUYET-DINH-CAN-CHOT.md` mục 9), nên dump database không chứa các bí mật này.

## Chưa làm ở Đợt 1 — không giả vờ đã làm

- Chưa có VPS, chưa có domain, chưa có HTTPS, chưa deploy lần nào.
- Chưa có PostgreSQL thật ở bất kỳ môi trường nào (kể cả staging) — mọi test và dữ liệu DEMO đều chạy trên PGlite.
- Chưa diễn tập backup/restore.
- Chưa có giám sát uptime/log tập trung cho dịch vụ này.
