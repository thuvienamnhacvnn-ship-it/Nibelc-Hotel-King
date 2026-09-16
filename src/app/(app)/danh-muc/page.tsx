import { Check } from "lucide-react";
import { Badge, Card, DemoBadge, EmptyState, KeyValue, Notice, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatInstant, hhmm } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS } from "@/modules/booking/types";
import { DATA_STATUS_LABELS, LISTING_STATUS_LABELS, PROPERTY_STATUS_LABELS, RESOURCE_KIND_LABELS, UNIT_KIND_LABELS, listingTone } from "@/modules/catalog/labels";
import { type CatalogOverview, catalogOverview } from "@/modules/catalog/queries";
import { EditListingButton, EditPropertyButton, EditUnitButton } from "./edit";
import s from "./danh-muc.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nhà / phòng / listing" };

type Property = CatalogOverview["properties"][number];

function DataStatus({ status, note }: { status: string; note: string | null }) {
  return (
    <div>
      <Badge tone={status === "confirmed" ? "ok" : "warn"}>{DATA_STATUS_LABELS[status] ?? status}</Badge>
      {note ? <div className="small muted">{note}</div> : null}
    </div>
  );
}

const ser = <T,>(v: T) => JSON.parse(JSON.stringify(v)) as T;

export default async function CatalogPage() {
  const actor = await requireActor("catalog.view");
  const data = await catalogOverview(actor);
  const canEdit = can(actor, "catalog.edit");
  const allUnits = data.properties.flatMap((p) => p.units);
  const allListings = data.properties.flatMap((p) => p.listings);

  return (
    <div className="stack">
      <PageHeader
        title="Nhà / phòng / listing"
        description={`${data.counts.properties} nhà · ${data.counts.resources} phòng vật lý · ${data.counts.units} sản phẩm bán · ${data.counts.listings} listing. Mã chuẩn là mã trong file Vietnam Team; tồn phòng tính trên phòng vật lý.`}
      />
      <Notice tone="info">
        Quan hệ nguyên căn ↔ phòng lẻ (sản phẩm gồm những phòng vật lý nào) không sửa được ở màn hình này: đổi quan hệ làm lệch tồn đã giữ nên cần migration/công cụ riêng có kiểm tra.
        {canEdit ? " Bạn sửa được trạng thái dữ liệu, ghi chú, sức chứa, hoạt động, thời lượng dọn và trạng thái listing — mọi thay đổi ghi nhật ký." : null}
      </Notice>

      {data.properties.length ? (
        <nav className="row small">
          <span className="label">Đi tới nhà:</span>
          {data.properties.map((p) => (
            <a key={p.id} href={`#nha-${p.code}`} className="btn btn-sm">
              {p.code}
            </a>
          ))}
          <a href="#can-xac-nhan" className="btn btn-sm">
            Cần xác nhận ({data.needsConfirmation.length})
          </a>
        </nav>
      ) : null}

      {data.properties.length === 0 ? (
        <Card>
          <EmptyState title="Chưa có nhà nào trong danh mục">Nhập danh mục (Excel hoặc công cụ nhập) trước khi tạo booking.</EmptyState>
        </Card>
      ) : (
        data.properties.map((p) => <PropertyCard key={p.id} property={p} canEdit={canEdit} tz={actor.timezone} />)
      )}

      <div id="can-xac-nhan" />
      <Card title={`Dữ liệu cần xác nhận (${data.needsConfirmation.length})`} pad={false}>
        {data.needsConfirmation.length === 0 ? (
          <EmptyState title="Không còn bản ghi cần xác nhận" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Loại</th>
                  <th>Mã</th>
                  <th>Bản ghi</th>
                  <th>Ghi chú</th>
                  <th>Cập nhật</th>
                  {canEdit ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {data.needsConfirmation.map((r) => (
                  <tr key={`${r.type}-${r.id}`}>
                    <td>{r.type === "property" ? "Nhà" : r.type === "unit" ? "Sản phẩm" : "Listing"}</td>
                    <td className="strong">{r.code}</td>
                    <td>{r.label}</td>
                    <td className="small">{r.note ?? <span className="faint">Chưa ghi lý do</span>}</td>
                    <td className="small">{formatInstant(r.updated_at, actor.timezone)}</td>
                    {canEdit ? (
                      <td>
                        {r.type === "property" ? (
                          <EditPropertyButton property={ser(data.properties.find((x) => x.id === r.id)!)} />
                        ) : r.type === "unit" ? (
                          <EditUnitButton unit={ser(allUnits.find((x) => x.id === r.id)!)} />
                        ) : (
                          <EditListingButton listing={ser(allListings.find((x) => x.id === r.id)!)} />
                        )}
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

function PropertyCard({ property: p, canEdit, tz }: { property: Property; canEdit: boolean; tz: string }) {
  const resCode = new Map(p.resources.map((r) => [r.id, r.code]));
  return (
    <section id={`nha-${p.code}`} className="stack">
      <Card
        title={
          <span className="row">
            {p.code} — {p.name} <DemoBadge show={p.is_demo} />
            <Badge tone={p.status === "active" ? "ok" : "neutral"}>{PROPERTY_STATUS_LABELS[p.status] ?? p.status}</Badge>
          </span>
        }
        actions={canEdit ? <EditPropertyButton property={ser({ ...p, resources: [], units: [], listings: [] })} /> : null}
      >
        <KeyValue
          items={[
            ["Địa chỉ", p.address],
            ["Nhận phòng", `${hhmm(p.check_in_from)}–${hhmm(p.check_in_until)} (${p.timezone})`],
            ["Trả phòng", `trước ${hhmm(p.check_out_at)}`],
            ["Dọn mặc định", `${p.default_clean_minutes} phút`],
            ["Dữ liệu", <DataStatus key="ds" status={p.data_status} note={p.data_note} />],
            ["Cập nhật", formatInstant(p.updated_at, tz)],
          ]}
        />
      </Card>

      <Card title={`Sản phẩm bán (${p.units.length})`} pad={false}>
        {p.units.length === 0 ? (
          <EmptyState title="Nhà chưa có sản phẩm" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mã</th>
                  <th>Tên</th>
                  <th>Loại</th>
                  <th className="num">Sức chứa</th>
                  <th>Giường</th>
                  <th>Dọn</th>
                  <th>Hoạt động</th>
                  <th>Phòng vật lý</th>
                  <th>Dữ liệu</th>
                  {canEdit ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {p.units.map((u) => (
                  <tr key={u.id}>
                    <td className="strong">
                      {u.code} <DemoBadge show={u.is_demo} />
                    </td>
                    <td>
                      {u.name}
                      {u.alias_count ? <div className="small faint">{u.alias_count} tên gọi khác</div> : null}
                    </td>
                    <td>
                      <Badge tone={u.kind === "whole" ? "info" : "neutral"}>{UNIT_KIND_LABELS[u.kind] ?? u.kind}</Badge>
                    </td>
                    <td className="num">{u.capacity}</td>
                    <td className="small">{u.bed_config ?? "—"}</td>
                    <td className="small">{u.clean_minutes ? `${u.clean_minutes} phút` : <span className="faint">mặc định {p.default_clean_minutes}</span>}</td>
                    <td>{u.active ? <Badge tone="ok">Đang bán</Badge> : <Badge tone="neutral">Ngừng</Badge>}</td>
                    <td className="small">
                      {u.resource_ids.length ? u.resource_ids.map((r) => resCode.get(r) ?? "?").join(", ") : <Badge tone="danger">Chưa gắn phòng</Badge>}
                    </td>
                    <td>
                      <DataStatus status={u.data_status} note={u.data_note} />
                    </td>
                    {canEdit ? (
                      <td>
                        <EditUnitButton unit={ser(u)} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Quan hệ tài nguyên (sản phẩm × phòng vật lý)" pad={false}>
        {p.resources.length === 0 || p.units.length === 0 ? (
          <EmptyState title="Chưa khai báo phòng vật lý">Không có phòng vật lý thì không giữ tồn được.</EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className={`table ${s.matrix}`}>
                <thead>
                  <tr>
                    <th>Sản phẩm</th>
                    {p.resources.map((r) => (
                      <th key={r.id} className={s.center} title={r.name}>
                        {r.code}
                        <div className={s.sub}>
                          {r.name} · {RESOURCE_KIND_LABELS[r.kind] ?? r.kind}
                          {!r.active ? " · ngừng" : ""}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.units.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <span className="strong">{u.code}</span> <span className="small faint">{UNIT_KIND_LABELS[u.kind]}</span>
                      </td>
                      {p.resources.map((r) => (
                        <td key={r.id} className={`${s.center} ${u.resource_ids.includes(r.id) ? s.on : ""}`}>
                          {u.resource_ids.includes(r.id) ? <Check size={16} aria-label="dùng phòng này" /> : <span className="faint">·</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-pad small muted">Hai sản phẩm có dấu ✓ ở cùng một cột dùng chung phòng đó: đặt một bên thì bên kia không bán được cùng đêm.</div>
          </>
        )}
      </Card>

      <Card title={`Listing theo kênh (${p.listings.length})`} pad={false}>
        {p.listings.length === 0 ? (
          <EmptyState title="Chưa có listing nào" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sản phẩm</th>
                  <th>Kênh</th>
                  <th>Tài khoản</th>
                  <th>Tên listing</th>
                  <th>Mã listing ngoài</th>
                  <th className="num">Sức chứa trên kênh</th>
                  <th>Trạng thái trên kênh</th>
                  <th>Dữ liệu</th>
                  {canEdit ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {p.listings.map((l) => (
                  <tr key={l.id}>
                    <td className="strong">
                      {l.unit_code} <DemoBadge show={l.is_demo} />
                    </td>
                    <td>{CHANNEL_LABELS[l.channel] ?? l.channel}</td>
                    <td className="small">{l.account_label ?? "—"}</td>
                    <td>{l.listing_name ?? <span className="faint">—</span>}</td>
                    <td className="mono">
                      {l.external_listing_id ?? <span className="faint">chưa có</span>}
                      {l.external_room_id ? <div className="small faint">phòng: {l.external_room_id}</div> : null}
                    </td>
                    <td className="num">{l.capacity_on_channel ?? "—"}</td>
                    <td>
                      <Badge tone={listingTone(l.status)} title="Trạng thái riêng của listing trên kênh này — không phải trạng thái toàn sản phẩm">
                        {LISTING_STATUS_LABELS[l.status] ?? l.status}
                      </Badge>
                    </td>
                    <td>
                      <DataStatus status={l.data_status} note={l.data_note} />
                    </td>
                    {canEdit ? (
                      <td>
                        <EditListingButton listing={ser(l)} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
