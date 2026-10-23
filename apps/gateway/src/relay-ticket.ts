import { SignJWT } from "jose";
import type { Env } from "./auth";
export async function mintRelayTicket(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const { roomId, deviceId, role, helloPubkey } = body;
  if (
    typeof roomId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
    typeof deviceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) ||
    !["desktop", "mobile"].includes(String(role)) ||
    typeof helloPubkey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(helloPubkey)
  )
    throw new Error("Invalid room identity");
  if (!env.RELAY_TICKET_SECRET || env.RELAY_TICKET_SECRET.length < 32)
    throw new Error("Relay admission is not configured");
  const entitlement = await env.DB.prepare(
    "SELECT status,expires_at FROM entitlements WHERE user_id=?",
  )
    .bind(userId)
    .first<{ status: string; expires_at: string }>();
  if (
    !entitlement ||
    entitlement.status !== "active" ||
    !Number.isFinite(Date.parse(entitlement.expires_at)) ||
    Date.parse(entitlement.expires_at) <= Date.now()
  )
    throw new Error("No active entitlement");
  if (role === "desktop" && roomId === deviceId)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO relay_rooms(room_id,user_id,updated_at) SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM relay_rooms WHERE user_id=?2)<5",
    )
      .bind(roomId, userId, new Date().toISOString())
      .run();
  const owner = await env.DB.prepare("SELECT user_id FROM relay_rooms WHERE room_id=?")
    .bind(roomId)
    .first<{ user_id: string }>();
  if (!owner || owner.user_id !== userId) throw new Error("Room is not owned by this account");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO relay_devices(room_id,device_id,hello_pubkey) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM relay_devices WHERE room_id=?)<8",
  )
    .bind(roomId, deviceId, helloPubkey, roomId)
    .run();
  const device = await env.DB.prepare(
    "SELECT hello_pubkey FROM relay_devices WHERE room_id=? AND device_id=?",
  )
    .bind(roomId, deviceId)
    .first<{ hello_pubkey: string }>();
  if (!device)
    throw new Error("Room device limit reached; remove the room registration to rotate devices");
  if (device.hello_pubkey !== helloPubkey)
    throw new Error("Device key changed; remove the old room registration first");
  await env.DB.prepare("UPDATE relay_rooms SET updated_at=? WHERE room_id=? AND user_id=?")
    .bind(new Date().toISOString(), roomId, userId)
    .run();
  return new SignJWT({ roomId, deviceId, role, helloPubkey })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("bimax-gateway")
    .setAudience("bimax-relay")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(env.RELAY_TICKET_SECRET));
}

/** Explicit account-owned management, avoiding surprising eviction of an active desktop. */
export async function removeRelayRoom(env: Env, userId: string, roomId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw new Error("Invalid room");
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM relay_devices WHERE room_id=? AND EXISTS(SELECT 1 FROM relay_rooms WHERE room_id=? AND user_id=?)",
    ).bind(roomId, roomId, userId),
    env.DB.prepare("DELETE FROM relay_rooms WHERE room_id=? AND user_id=?").bind(roomId, userId),
  ]);
}
