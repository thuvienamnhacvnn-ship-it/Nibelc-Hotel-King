import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryOne } from "@/lib/db";
import { htmlToText, parseEmail } from "@/modules/mailintake/parse";
import { runMailIntake } from "@/modules/mailintake/service";
import { type Fixture, makeFixture } from "./helpers";

/**
 * Nhận thư đặt phòng từ kênh. Thư thật của Booking.com là HTML, mã quoted-printable, tiêu đề
 * mã hoá =?utf-8?B?...?= — bộ bóc phải qua được cả ba thứ đó.
 */

let mailDir = "";
let fixture: Fixture;
let orgSlug = "";

beforeAll(() => {
  mailDir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-mail-"));
  process.env.MAIL_INTAKE_DIR = mailDir;
});
afterAll(() => fs.rmSync(mailDir, { recursive: true, force: true }));
beforeEach(async () => {
  process.env.MAIL_INTAKE_DIR = mailDir;
  fixture = await makeFixture();
  orgSlug = (await queryOne<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [fixture.orgId]))!.slug;
  for (const d of ["new", "cur"]) fs.rmSync(path.join(mailDir, d), { recursive: true, force: true });
});

/** Đặt một thư vào hộp new/ giống hệt cách Postfix ghi. */
function datThu(ten: string, raw: string) {
  fs.mkdirSync(path.join(mailDir, "new"), { recursive: true });
  fs.writeFileSync(path.join(mailDir, "new", ten), raw.replace(/\n/g, "\r\n"));
}

const thuBooking = (id: string, extra = "") =>
  [
    "Return-Path: <noreply@booking.com>",
    "From: Booking.com <noreply@booking.com>",
    "To: datphong@vietduc-hub.com",
    // Tiêu đề tiếng Việt mã hoá base64: "Đặt phòng mới"
    "Subject: =?utf-8?B?xJDhurd0IHBow7JuZyBt4bubaQ==?=",
    `Message-Id: <${id}@booking.com>`,
    "Date: Tue, 06 Oct 2026 09:15:00 +0200",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="BND1"',
    "",
    "--BND1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Ma dat phong: 6259688448=",
    "0",
    "Khach: Istvan Kosa",
    extra,
    "--BND1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Ban HTML</p></body></html>",
    "--BND1--",
    "",
  ].join("\n");

describe("nhận thư đặt phòng từ kênh", () => {
  it("bóc được tiêu đề mã hoá, chữ quoted-printable và chọn bản text thay vì HTML", () => {
    const m = parseEmail(thuBooking("abc1").replace(/\n/g, "\r\n"));
    expect(m.subject).toBe("Đặt phòng mới");
    expect(m.from).toBe("noreply@booking.com");
    expect(m.messageId).toBe("abc1@booking.com");
    // "=\n" là dấu nối dòng của quoted-printable: mã phải liền lại thành 10 chữ số.
    expect(m.text).toContain("6259688448");
    expect(m.text).toContain("Istvan Kosa");
    expect(m.text).not.toContain("Ban HTML");
    expect(m.date?.toISOString()).toBe("2026-10-06T07:15:00.000Z");
  });

  it("thư chỉ có HTML thì bóc thẻ ra lấy chữ", () => {
    const raw = [
      "From: Airbnb <automated@airbnb.com>",
      "To: datphong@vietduc-hub.com",
      "Subject: New booking",
      "Message-Id: <h1@airbnb.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<div><b>Guest:</b> Lili Varga<br/>Code: HMFSPAZAZZ</div>",
      "",
    ].join("\r\n");
    const m = parseEmail(raw);
    expect(m.text).toContain("Lili Varga");
    expect(m.text).toContain("HMFSPAZAZZ");
    expect(m.text).not.toContain("<div>");
  });

  it("cất thư vào hệ thống, chuyển tệp sang cur, chạy lại không nhân bản", async () => {
    datThu("1.mail", thuBooking("dup1"));
    const r1 = await runMailIntake(orgSlug);
    expect(r1).toMatchObject({ seen: 1, stored: 1, duplicate: 0, failed: 0 });
    expect(fs.readdirSync(path.join(mailDir, "new"))).toHaveLength(0);
    expect(fs.readdirSync(path.join(mailDir, "cur"))).toHaveLength(1);

    // Kênh gửi lại đúng thư đó: cùng Message-Id ⇒ không sinh bản ghi thứ hai.
    datThu("2.mail", thuBooking("dup1"));
    const r2 = await runMailIntake(orgSlug);
    expect(r2).toMatchObject({ stored: 0, duplicate: 1 });

    const row = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM inbound_emails WHERE org_id = $1", [fixture.orgId]);
    expect(row?.n).toBe(1);
  });

  it("thư của người lạ vẫn cất nhưng đánh dấu bỏ qua, không lẫn với thư kênh", async () => {
    datThu("3.mail", thuBooking("x1").replace("From: Booking.com <noreply@booking.com>", "From: Ai Do <ke@la.com>"));
    await runMailIntake(orgSlug);
    const row = await queryOne<{ status: string; detected_kind: string | null }>(
      "SELECT status, detected_kind FROM inbound_emails WHERE org_id = $1",
      [fixture.orgId],
    );
    expect(row?.status).toBe("ignored");
    expect(row?.detected_kind).toBeNull();
  });

  it("tên miền giả mạo đuôi booking.com không được nhận là thư của kênh", async () => {
    // "booking.com.ke-gian.net" trông giống nhưng là miền của kẻ khác — phải bị xếp vào nhóm bỏ qua.
    const raw = thuBooking("f1").replace("From: Booking.com <noreply@booking.com>", "From: Booking <noreply@booking.com.ke-gian.net>");
    datThu("9.mail", raw);
    await runMailIntake(orgSlug);
    const row = await queryOne<{ from_addr: string; status: string; detected_kind: string | null }>(
      "SELECT from_addr, status, detected_kind FROM inbound_emails WHERE org_id = $1",
      [fixture.orgId],
    );
    expect(row?.from_addr).toBe("noreply@booking.com.ke-gian.net");
    expect(row?.status).toBe("ignored");
    expect(row?.detected_kind).toBeNull();
  });

  it("bóc thẻ HTML giữ được xuống dòng để chữ còn đọc được", () => {
    expect(htmlToText("<p>Dòng 1</p><p>Dòng 2</p>")).toBe("Dòng 1\nDòng 2");
    expect(htmlToText("<script>xoa()</script><p>Còn lại</p>")).toBe("Còn lại");
  });
});
