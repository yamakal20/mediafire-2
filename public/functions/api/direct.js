// functions/api/direct.js
// Cloudflare Pages Function — endpoint: /api/direct?url=<mediafire_link>

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const mfUrl = url.searchParams.get("url");

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Preflight request
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!mfUrl || !mfUrl.includes("mediafire.com")) {
    return jsonResponse(
      { success: false, error: "မှန်ကန်တဲ့ MediaFire link ထည့်ပါ" },
      400,
      corsHeaders
    );
  }

  // ---- Cache ----
  // Cloudflare edge cache ကို သုံးပြီး KV/bandwidth limit မထိအောင် cache လုပ်တယ်
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  let cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const directLink = await resolveMediaFire(mfUrl);

    if (!directLink) {
      return jsonResponse(
        { success: false, error: "Direct link ရှာမတွေ့ပါ။ Link မှန်/မမှန် ပြန်စစ်ပါ" },
        404,
        corsHeaders
      );
    }

    const response = jsonResponse(
      { success: true, direct: directLink, source: mfUrl },
      200,
      {
        ...corsHeaders,
        // 30 မိနစ် cache (Cloudflare edge + browser)
        "Cache-Control": "public, max-age=1800, s-maxage=1800",
      }
    );

    // edge cache ထဲ ထည့်တယ် (background)
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return jsonResponse(
      { success: false, error: "Server error: " + err.message },
      500,
      corsHeaders
    );
  }
}

// MediaFire HTML page ကို fetch လုပ်ပြီး direct download URL ကို extract လုပ်တယ်
async function resolveMediaFire(mfUrl) {
  const res = await fetch(mfUrl, {
    headers: {
      // browser တစ်ခုလို ဟန်ဆောင်ဖို့
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) return null;
  const html = await res.text();

  // MediaFire က direct link ကို ဒီ pattern တွေနဲ့ ထည့်ထားတယ်
  // Pattern 1: id="downloadButton" href="..."
  let match = html.match(
    /href="(https?:\/\/download[^"]+\.mediafire\.com\/[^"]+)"/i
  );
  if (match) return decodeHtml(match[1]);

  // Pattern 2: aria-label="Download file" href="..."
  match = html.match(
    /(https?:\/\/download\d*\.mediafire\.com\/[a-zA-Z0-9]+\/[^\s"'<>]+)/i
  );
  if (match) return decodeHtml(match[1]);

  // Pattern 3: scrambledUrl (အသစ်တွေမှာ base64 encode လုပ်ထားတတ်တယ်)
  match = html.match(/data-scrambled-url="([^"]+)"/i);
  if (match) {
    try {
      return atob(match[1]);
    } catch (e) {
      // ignore
    }
  }

  return null;
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
