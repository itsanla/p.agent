import { NextRequest } from "next/server";
import { clearChatHistory, getChatHistory } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ phone: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteContext): Promise<Response> {
  try {
    const { phone } = await params;
    const messages = await getChatHistory(decodeURIComponent(phone));
    return Response.json({ phone, messages });
  } catch (err) {
    console.error("[conversations] detail failed:", err);
    return Response.json({ error: "Failed to load conversation" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext): Promise<Response> {
  try {
    const { phone } = await params;
    await clearChatHistory(decodeURIComponent(phone));
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[conversations] delete failed:", err);
    return Response.json({ error: "Failed to clear conversation" }, { status: 500 });
  }
}
