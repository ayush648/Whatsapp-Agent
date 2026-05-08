import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const before = sp.get("before");
  const limit = Math.min(
    parseInt(sp.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT,
    MAX_LIMIT
  );

  let query = supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Return oldest-first for UI; client can detect more via length === limit
  const messages = (data ?? []).reverse();
  return Response.json({ messages, has_more: (data?.length ?? 0) === limit });
}
