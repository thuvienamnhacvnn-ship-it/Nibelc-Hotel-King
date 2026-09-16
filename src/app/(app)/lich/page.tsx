import { AlertTriangle, Ban, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { addDays, diffDays, formatDateVi, weekdayVi } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS, STAY_STATUS_LABELS } from "@/modules/booking/types";
import { type CalendarAllocation, type CalendarData, type CalendarUnit, type CellItem, calendarData, parseCalendarParams, unitOptions } from "@/modules/calendar/queries";
import { READINESS_LABELS } from "@/modules/cleaning/readiness";
import { UNIT_KIND_LABELS, readinessTone } from "@/modules/catalog/labels";
import { CreateBlockButton, ReleaseBlockButton } from "./actions";
import s from "./lich.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lịch phòng" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("calendar.view");
  const sp = await searchParams;
  const params = parseCalendarParams((k) => (typeof sp[k] === "string" ? (sp[k] as string) : null), actor.timezone);
  const data = await calendarData(actor, params);
  const canBlock = can(actor, "inventory.block");
  const units = canBlock ? await unitOptions(actor) : [];

  const href = (over: Partial<{ start: string; days: number; property: string | null }>) => {
    const q = new URLSearchParams();
    q.set("start", over.start ?? params.start);
    q.set("days", String(over.days ?? params.days));
    const property = over.property === undefined ? params.propertyId : over.property;
    if (property) q.set("property", property);
    return `/lich?${q.toString()}`;
  };
  const lastNight = data.nights[data.nights.length - 1];

  return (
    <div className="stack">
      <PageHeader
        title="Lịch phòng"
        description={
          <>
            Mỗi ô là một đêm, ngày theo giờ Budapest (<strong>{data.timezoneLabel}</strong>). Nguyên căn và phòng lẻ dùng chung phòng vật lý nên chặn lẫn nhau. Đổi lịch booking:
            mở booking rồi tạo yêu cầu thay đổi — lịch không kéo-thả.
          </>
        }
        actions={canBlock ? <CreateBlockButton units={units} defaultStart={params.start} /> : null}
      />

      <div className={`card card-pad ${s.toolbar}`}>
        <div className="row">
          {([1, 7, 14] as const).map((d) => (
            <Link key={d} href={href({ days: d })} className={`btn btn-sm ${params.days === d ? "btn-primary" : ""}`} aria-current={params.days === d ? "page" : undefined}>
              {d === 1 ? "1 ngày" : `${d} ngày`}
            </Link>
          ))}
        </div>
        <div className="row">
          <Link className="btn btn-sm" href={href({ start: addDays(params.start, -params.days) })} aria-label="Khoảng trước">
            <ChevronLeft size={16} /> Trước
          </Link>
          <Link className="btn btn-sm" href={href({ start: data.today })}>
            Hôm nay
          </Link>
          <Link className="btn btn-sm" href={href({ start: addDays(params.start, params.days) })} aria-label="Khoảng sau">
            Sau <ChevronRight size={16} />
          </Link>
          <form method="get" action="/lich" className="row">
            <input type="hidden" name="days" value={params.days} />
            {params.propertyId ? <input type="hidden" name="property" value={params.propertyId} /> : null}
            <input type="date" name="start" defaultValue={params.start} className="input" style={{ width: 160, minHeight: 30 }} aria-label="Từ ngày" />
            <button className="btn btn-sm" type="submit">
              Xem
            </button>
          </form>
        </div>
        <div className="row">
          <span className="label">Nhà</span>
          <Link href={href({ property: null })} className={`btn btn-sm ${!params.propertyId ? "btn-primary" : ""}`}>
            Tất cả
          </Link>
          {data.allProperties.map((p) => (
            <Link key={p.id} href={href({ property: p.id })} className={`btn btn-sm ${params.propertyId === p.id ? "btn-primary" : ""}`}>
              {p.code}
            </Link>
          ))}
        </div>
      </div>

      <div className="small muted">
        {params.days === 1 ? (
          <>
            Đêm {weekdayVi(params.start)} {formatDateVi(params.start)} → sáng {formatDateVi(data.end)}
          </>
        ) : (
          <>
            Đêm {formatDateVi(params.start)} → đêm {formatDateVi(lastNight)} ({data.days} đêm, khách cuối cùng trả phòng sáng {formatDateVi(data.end)})
          </>
        )}
      </div>

      {data.conflictCount ? (
        <Notice tone="danger" title={`${data.conflictCount} phân bổ xung đột trong khoảng đang xem`}>
          Kênh bán đã nhận booking trùng đêm với tồn đã bị chiếm. Phân bổ xung đột không giữ phòng. <Link href="/duyet">Xử lý xung đột</Link>
        </Notice>
      ) : null}

      {data.properties.length === 0 ? (
        <Card>
          <EmptyState title="Chưa có nhà nào">Danh mục nhà/phòng trống — nhập danh mục trước khi xem lịch.</EmptyState>
        </Card>
      ) : params.days === 1 ? (
        <DayList data={data} />
      ) : (
        <Card pad={false}>
          <Legend />
          <div className={s.scroll}>
            <table className={`${s.grid} ${params.days === 14 ? s.dense : ""}`}>
              <thead>
                <tr>
                  <th className={`${s.sticky} ${s.corner}`}>Phòng / sản phẩm</th>
                  {data.nights.map((n) => (
                    <th key={n} className={`${s.dayHead} ${n === data.today ? s.today : ""} ${isWeekend(n) ? s.weekend : ""}`}>
                      <Link href={href({ start: n, days: 1 })} title="Xem theo ngày">
                        <span className={s.wd}>{weekdayVi(n)}</span> {formatDateVi(n).slice(0, 5)}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.properties.map((p) => (
                  <PropertyRows key={p.id} property={p} data={data} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title={`Chặn tồn trong khoảng đang xem (${data.blocks.length})`} pad={false}>
        {data.blocks.length === 0 ? (
          <EmptyState title="Không có chặn tồn">Chặn tồn dùng cho bảo trì, chủ nhà dùng, sự cố. {canBlock ? "Tạo bằng nút “Chặn tồn” ở trên." : ""}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sản phẩm</th>
                  <th>Từ đêm</th>
                  <th>Đến (ngày mở lại)</th>
                  <th className="num">Số đêm</th>
                  <th>Lý do</th>
                  <th>Người tạo</th>
                  {canBlock ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {data.blocks.map((b) => (
                  <tr key={b.id} id={`block-${b.id}`}>
                    <td className="strong">{b.unit_code}</td>
                    <td>{formatDateVi(b.start_date)}</td>
                    <td>{formatDateVi(b.end_date)}</td>
                    <td className="num">{diffDays(b.start_date, b.end_date)}</td>
                    <td>{b.reason}</td>
                    <td className="small">{b.created_by_name ?? "—"}</td>
                    {canBlock ? (
                      <td>
                        <ReleaseBlockButton block={{ id: b.id, unitCode: b.unit_code, startDate: b.start_date, endDate: b.end_date, reason: b.reason }} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function isWeekend(date: string) {
  const w = weekdayVi(date);
  return w === "T7" || w === "CN";
}

function Legend() {
  return (
    <div className={`row small ${s.legend}`}>
      <span className={`${s.chip} ${s.chipBooking}`}>Booking</span>
      <span className={`${s.chip} ${s.chipDemo}`}>Booking DEMO</span>
      <span className={`${s.chip} ${s.chipConflict}`}>
        <AlertTriangle size={12} /> Xung đột (không giữ phòng)
      </span>
      <span className={`${s.chip} ${s.chipBlock}`}>
        <Ban size={12} /> Chặn tồn
      </span>
      <span className={s.indirect}>bị chặn bởi X = phòng dùng chung đang bị chiếm</span>
    </div>
  );
}

function UnitHead({ unit }: { unit: CalendarUnit }) {
  return (
    <div className={s.unitHead}>
      <div>
        <span className="strong">{unit.code}</span> {!unit.active ? <Badge tone="neutral">Ngừng</Badge> : null}
      </div>
      <div className={s.unitMeta}>
        {UNIT_KIND_LABELS[unit.kind]} · {unit.capacity} khách
      </div>
      <Badge tone={readinessTone(unit.readiness)} title="Trạng thái sẵn sàng hôm nay (tổng hợp từ các phòng vật lý)">
        {READINESS_LABELS[unit.readiness]}
      </Badge>
      {unit.resource_ids.length === 0 ? (
        <Badge tone="danger" title="Sản phẩm chưa gắn phòng vật lý — không giữ tồn được">
          Chưa gắn phòng
        </Badge>
      ) : null}
    </div>
  );
}

function PropertyRows({ property, data }: { property: CalendarData["properties"][number]; data: CalendarData }) {
  return (
    <>
      <tr className={s.propRow}>
        <th className={s.sticky}>
          {property.code} <DemoBadge show={property.is_demo} />
        </th>
        <td colSpan={data.nights.length}>
          <span className="small muted">{property.name}</span>
        </td>
      </tr>
      {property.units.length === 0 ? (
        <tr>
          <th className={s.sticky}>
            <span className="faint small">Chưa có sản phẩm</span>
          </th>
          <td colSpan={data.nights.length} />
        </tr>
      ) : (
        property.units.map((u) => (
          <tr key={u.id} className={!u.active ? s.inactive : undefined}>
            <th className={s.sticky} scope="row">
              <UnitHead unit={u} />
            </th>
            {data.nights.map((n) => (
              <td key={n} className={`${s.cell} ${n === data.today ? s.todayCol : ""}`}>
                <Cell items={data.cells[`${u.id}|${n}`] ?? []} />
              </td>
            ))}
          </tr>
        ))
      )}
    </>
  );
}

function bookingLabel(a: CalendarAllocation) {
  return `${a.external_ref ?? "(không mã)"} · ${CHANNEL_LABELS[a.source_channel] ?? a.source_channel}${a.guests != null ? ` · ${a.guests} khách` : ""}`;
}

function Cell({ items }: { items: CellItem[] }) {
  if (items.length === 0) return null;
  const direct = items.filter((i) => i.type !== "indirect");
  const indirect = [...new Map(items.filter((i) => i.type === "indirect").map((i) => [i.byUnitCode, i])).values()];
  return (
    <div className={s.cellStack}>
      {direct
        .sort((a, b) => rank(a) - rank(b))
        .map((item) => {
          if (item.type === "booking") {
            const a = item.allocation;
            const conflict = a.status === "conflict";
            const cls = conflict ? s.chipConflict : a.is_demo ? s.chipDemo : s.chipBooking;
            return (
              <Link
                key={a.allocation_id}
                href={`/bookings/${a.booking_id}`}
                className={`${s.chip} ${cls} ${item.startsHere ? "" : s.cont}`}
                title={`${bookingLabel(a)}${a.guest_name ? ` · ${a.guest_name}` : ""} · ${STAY_STATUS_LABELS[a.stay_status] ?? a.stay_status}${conflict ? " · XUNG ĐỘT — không giữ phòng" : ""}${a.is_demo ? " · DEMO" : ""}`}
              >
                {conflict ? <AlertTriangle size={12} aria-label="Xung đột" /> : null}
                {item.startsHere ? (
                  <span className={s.chipText}>
                    <span className="strong">{a.external_ref ?? "(không mã)"}</span>
                    <span className={s.chipSub}>
                      {CHANNEL_LABELS[a.source_channel] ?? a.source_channel}
                      {a.guests != null ? ` · ${a.guests}k` : ""}
                      {a.is_demo ? " · DEMO" : ""}
                    </span>
                    {a.guest_name ? <span className={s.chipSub}>{a.guest_name}</span> : null}
                  </span>
                ) : (
                  <span className={s.chipText}>{a.external_ref ?? "…"}</span>
                )}
              </Link>
            );
          }
          if (item.type === "block") {
            return (
              <a key={item.block.id} href={`#block-${item.block.id}`} className={`${s.chip} ${s.chipBlock} ${item.startsHere ? "" : s.cont}`} title={`Chặn tồn: ${item.block.reason}`}>
                <Ban size={12} aria-label="Chặn tồn" />
                <span className={s.chipText}>{item.startsHere ? item.block.reason : "chặn"}</span>
              </a>
            );
          }
          return null;
        })}
      {indirect.map((i) =>
        i.type === "indirect" ? (
          <span key={i.byUnitCode} className={s.indirect} title={`Phòng dùng chung đang bị chiếm bởi ${i.byUnitCode} (${i.label})`}>
            bị chặn bởi {i.byUnitCode}
          </span>
        ) : null,
      )}
    </div>
  );
}

function rank(i: CellItem) {
  if (i.type === "booking") return i.allocation.status === "conflict" ? 0 : 1;
  return i.type === "block" ? 2 : 3;
}

/** Chế độ 1 ngày: danh sách theo phòng — đêm nay, nhận, trả. */
function DayList({ data }: { data: CalendarData }) {
  const day = data.start;
  return (
    <Card pad={false} title={`${weekdayVi(day)} ${formatDateVi(day)}${day === data.today ? " (hôm nay)" : ""}`}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Phòng / sản phẩm</th>
              <th>Đêm {formatDateVi(day).slice(0, 5)}</th>
              <th>Nhận phòng</th>
              <th>Trả phòng</th>
            </tr>
          </thead>
          <tbody>
            {data.properties.map((p) => (
              <DayRows key={p.id} property={p} data={data} day={day} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DayRows({ property, data, day }: { property: CalendarData["properties"][number]; data: CalendarData; day: string }) {
  return (
    <>
      <tr>
        <td colSpan={4} className={s.dayProp}>
          <span className="strong">{property.code}</span> <span className="small muted">{property.name}</span> <DemoBadge show={property.is_demo} />
        </td>
      </tr>
      {property.units.map((u) => {
        const mine = data.allocations.filter((a) => a.unit_id === u.id);
        const arrivals = mine.filter((a) => a.start_date === day);
        const departures = mine.filter((a) => a.end_date === day);
        return (
          <tr key={u.id} className={!u.active ? s.inactive : undefined}>
            <td>
              <UnitHead unit={u} />
            </td>
            <td>
              <Cell items={data.cells[`${u.id}|${day}`] ?? []} />
              {(data.cells[`${u.id}|${day}`] ?? []).length === 0 ? <span className="faint small">Trống</span> : null}
            </td>
            <td>
              <MoveList rows={arrivals} />
            </td>
            <td>
              <MoveList rows={departures} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

function MoveList({ rows }: { rows: CalendarAllocation[] }) {
  if (rows.length === 0) return <span className="faint small">—</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {rows.map((a) => (
        <div key={a.allocation_id} className="small">
          {a.status === "conflict" ? <Badge tone="danger">Xung đột</Badge> : null} <Link href={`/bookings/${a.booking_id}`}>{bookingLabel(a)}</Link> <DemoBadge show={a.is_demo} />
          {a.guest_name ? <div className="faint">{a.guest_name}</div> : null}
          <div className="faint">{STAY_STATUS_LABELS[a.stay_status] ?? a.stay_status}</div>
        </div>
      ))}
    </div>
  );
}
