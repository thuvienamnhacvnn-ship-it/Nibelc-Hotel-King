import { api } from "@/lib/http";
import { getPhotoFile, replacePhoto } from "@/modules/photos/service";

/** Trả file ảnh sau khi kiểm quyền + tổ chức. Không cache ở trình duyệt hay proxy. */
export const GET = api<{ id: string }>(async (_req, actor, { id }) => {
  const { data, mimeType } = await getPhotoFile(actor, id);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
});

/** Thay ảnh: đánh dấu 'replaced', không xoá file. */
export const DELETE = api<{ id: string }>(async (req, actor, { id }) => {
  const reason = new URL(req.url).searchParams.get("reason");
  return replacePhoto(actor, id, reason?.slice(0, 500) ?? null);
});
