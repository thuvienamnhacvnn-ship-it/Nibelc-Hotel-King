import type { Tone } from "@/components/ui";

export function bookingTone(status: string): Tone {
  return status === "cancelled" ? "danger" : status === "hold" ? "warn" : "ok";
}

export function stayTone(status: string): Tone {
  return status === "checked_in" ? "info" : status === "checked_out" ? "ok" : status === "no_show" ? "danger" : "neutral";
}

export function changeRequestTone(status: string): Tone {
  return status === "pending" ? "warn" : status === "applied" ? "ok" : status === "rejected" || status === "failed" ? "danger" : "neutral";
}
