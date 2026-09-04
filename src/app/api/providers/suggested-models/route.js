import { FILTERS } from "./filters.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return Response.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return Response.json({ error: "Unknown filter type" }, { status: 400 });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return Response.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return Response.json({ data });
  } catch {
    return Response.json({ data: [] });
  }
}
