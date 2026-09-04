// Minimal "next/server" shim. After the codemod, migrated route files no
// longer import this module — but shared libs they depend on still do
// (src/dashboardGuard.js uses NextResponse in its middleware-side code, which
// never runs in this process; only isLocalRequest is consumed).
export class NextResponse extends Response {
  static json(data, init) {
    return Response.json(data, init);
  }
  static redirect(url, status = 307) {
    return Response.redirect(url, status);
  }
  static next() {
    // Middleware-only concept; nothing in this process should call it.
    return new Response(null, { status: 200 });
  }
  get cookies() {
    throw new Error("NextResponse.cookies is not supported by the hono-server shim");
  }
}

export class NextRequest extends Request {}

export const revalidate = () => {};
export const unstable_noStore = () => {};

export default { NextResponse, NextRequest };
