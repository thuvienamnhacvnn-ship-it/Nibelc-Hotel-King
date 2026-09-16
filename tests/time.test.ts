import { describe, expect, it } from "vitest";
import { addDays, diffDays, formatInstant, localDateOf, localToUtc } from "@/lib/time";
import { formatMoney, parseMoneyToMinor } from "@/lib/money";

describe("Giờ Budapest và đổi giờ mùa hè", () => {
  it("15:00 trước và sau ngày đổi giờ mùa xuân (29/03/2026)", () => {
    expect(localToUtc("2026-03-28", "15:00").toISOString()).toBe("2026-03-28T14:00:00.000Z");
    expect(localToUtc("2026-03-29", "15:00").toISOString()).toBe("2026-03-29T13:00:00.000Z");
  });

  it("giờ không tồn tại 02:30 ngày 29/03 được đẩy về sau khoảng nhảy", () => {
    const t = localToUtc("2026-03-29", "02:30");
    expect(t.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(formatInstant(t)).toBe("29/03/2026 03:30 CEST");
  });

  it("giờ lặp 02:30 ngày 25/10/2026 lấy lần đầu (CEST)", () => {
    expect(localToUtc("2026-10-25", "02:30").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(localToUtc("2026-10-25", "10:00").toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });

  it("ngày vận hành qua nửa đêm tính theo Budapest, không theo UTC", () => {
    expect(localDateOf(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
    expect(localDateOf(new Date("2026-01-01T22:30:00Z"))).toBe("2026-01-01");
    expect(localDateOf(new Date("2026-01-01T23:30:00Z"))).toBe("2026-01-02");
  });

  it("số đêm qua đêm đổi giờ vẫn đúng", () => {
    expect(diffDays("2026-03-28", "2026-03-30")).toBe(2);
    expect(diffDays("2026-10-24", "2026-10-26")).toBe(2);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("Tiền theo đơn vị nhỏ nhất", () => {
  it("không dùng số thực", () => {
    expect(parseMoneyToMinor("460,86")).toBe(46086);
    expect(parseMoneyToMinor("0.1")).toBe(10);
    expect(parseMoneyToMinor("20")).toBe(2000);
    expect(() => parseMoneyToMinor("1.234")).toThrow();
    expect(formatMoney(46086, "EUR", "en-US")).toBe("€460.86");
  });
});
