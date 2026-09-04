import { LOCALE_COOKIE, normalizeLocale, isSupportedLocale } from "@/i18n/config";

export async function POST(request) {
  try {
    const { locale } = await request.json();

    if (!locale || !isSupportedLocale(locale)) {
      return Response.json(
        { error: "Invalid locale" },
        { status: 400 }
      );
    }

    const normalized = normalizeLocale(locale);
    // Same attributes Next's cookies().set() emitted for this route:
    // name=value; Path=/; Expires=<+1yr>; Max-Age=<1yr>, no others.
    const maxAge = 60 * 60 * 24 * 365;
    return Response.json({ success: true, locale: normalized }, {
      headers: {
        "Set-Cookie": `${LOCALE_COOKIE}=${normalized}; Path=/; Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}; Max-Age=${maxAge}`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: "Failed to set locale" },
      { status: 500 }
    );
  }
}
