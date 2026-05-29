import { getAllActiveChats } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const chats = await getAllActiveChats();
    return Response.json({ chats });
  } catch (err) {
    console.error("[conversations] list failed:", err);
    return Response.json({ error: "Failed to load conversations" }, { status: 500 });
  }
}
