// functions/api/direct.js
// Cloudflare Pages Function — /api/direct?url=<mediafire_link>

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const mfUrl = url.searchParams.get("url");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!mfUrl || !mfUrl.includes("mediafire.com")) {
    return json({ success: false, error: "မှန်ကန်တဲ့ MediaFire link ထည့်ပါ" }, 400, corsHeaders);
  }

  // ---- Cache (edge) ----
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    // file key ကို link ထဲက ထုတ်ယူ
    const m = mfUrl.match(/mediafire\.com\/(?:file|file_premium|download|view)\/([a-zA-Z0-9]+)/);
    const fileKey = m ? m[1] : null;

    let direct = null;
    let filename = null;

    // ===== Method 1: Official API (အကောင်းဆုံး) =====
    if (fileKey) {
      const apiUrl =
        `https://www.mediafire.com/api/file/get_info.php?quick_key=${fileKey}&response_format=json`;
      const apiRes = await fetch(apiUrl, { headers: browserHeaders() });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const info = data?.response?.file_info;
        if (info) {
          filename = info.filename || null;
          direct = info?.links?.normal_download || null;
          // normal_download ကိုယ်တိုင်က redirect link ဖြစ်တတ်တယ် — resolve လုပ်
          if (direct) {
            const resolved = await followToDirect(direct);
            if (resolved) direct = resolved;
          }
        }
      }
    }

    // ===== Method 2: HTML scraping (API fail ရင် fallback) =====
    if (!direct) {
      direct = await scrapeHtml(mfUrl);
    }

    if (!direct) {
      return json(
        { success: false, error: "Direct link ရှာမတွေ့ပါ။ File ဖျက်ထား/Link မှား ဖြစ်နိုင်ပါတယ်" },
        404, corsHeaders
      );
    }

    const response = json(
      { success: true, direct, filename, source: mfUrl },
      200,
      { ...corsHeaders, "Cache-Control": "public, max-age=1200, s-maxage=1200" }
    );

    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return json({ success: false, error: "Server error: " + err.message }, 500, corsHeaders);
  }
}

// download page ကို ဖွင့်ပြီး data-scrambled-url ကို resolve လုပ်
async function followToDirect(link) {
  if (link.includes("download") && /download\d*\.mediafire\.com/.test(link)) {
    return link; // ဒါက direct ဖြစ်နေပြီ
  }
  return await scrapeHtml(link);
}

// HTML page ကနေ direct link ထုတ်
async function scrapeHtml(pageUrl) {
  const res = await fetch(pageUrl, { headers: browserHeaders() });
  if (!res.ok) return null;
  const html = await res.text();

  // Pattern A: id="downloadButton" data-scrambled-url="<base64>"
  let m = html.match(/id="downloadButton"[^>]*data-scrambled-url="([^"]+)"/i);
  if (!m) m = html.match(/data-scrambled-url="([^"]+)"/i);
  if (m) {
    try {
      const decoded = atob(m[1].trim());
      if (decoded.startsWith("http")) return decoded;
    } catch (e) { /* ignore */ }
  }

  // Pattern B: downloadButton href တိုက်ရိုက်
  m = html.match(/id="downloadButton"[^>]*href="(https?:\/\/download[^"]+)"/i);
  if (m) return decodeHtml(m[1]);

  // Pattern C: download<n>.mediafire.com link တစ်ခုခု
  m = html.match(/(https?:\/\/download\d*\.mediafire\.com\/[^\s"'<>\\]+)/i);
  if (m) return decodeHtml(m[1]);

  return null;
}

function browserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Accept": "text/html,application/xhtml+xml,application/json",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
