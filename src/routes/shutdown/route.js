import { headers } from "next/headers";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ success: false, message: "Not allowed in production" }, { status: 403 });
  }

  const secret = process.env.SHUTDOWN_SECRET;
  const authorization = headers().get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const response = Response.json({ success: true, message: "Shutting down..." });

  setTimeout(() => {
    process.exit(0);
  }, 500);

  return response;
}

