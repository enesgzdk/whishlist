// api/product.js
async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-pin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const SYNC_PIN = (process.env.SYNC_PIN || '').trim();

    const sbFetch = async (path, options = {}) => {
      const headers = {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(options.headers || {})
      };
      if (!SUPABASE_KEY.startsWith('sb_')) {
        headers['Authorization'] = `Bearer ${SUPABASE_KEY}`;
      }

      const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      return { ok: response.ok, status: response.status, data };
    };

    const { action, url, q, id } = req.query;

    // 1. SUPABASE VERİTABANI İŞLEMLERİ
    if (action === 'list' || req.method === 'POST' || req.method === 'DELETE') {
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ ok: false, error: 'SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY eksik.' });
      }

      const incomingPin = (req.headers['x-sync-pin'] || '').trim();
      if (SYNC_PIN && incomingPin !== SYNC_PIN) {
        return res.status(401).json({ ok: false, error: 'Hatalı PIN kodu.' });
      }

      if (req.method === 'GET' && action === 'list') {
        const result = await sbFetch('wishlist_items?select=*&order=created_at.desc');
        if (!result.ok) return res.status(500).json({ ok: false, error: JSON.stringify(result.data) });
        return res.status(200).json({ ok: true, items: result.data || [] });
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const itemsToSave = Array.isArray(body) ? body : [body];

        const formatted = itemsToSave.map(item => ({
          id: String(item.id),
          title: item.title,
          price: Number(item.price) || 0,
          image: item.image || '',
          link: item.link || '',
          category: item.category || 'Genel',
          tag: item.tag || 'Yakın Zamanda',
          want: Number(item.want) || 5,
          need: Number(item.need) || 5,
          urgency: Number(item.urgency) || 3,
          purchased: Boolean(item.purchased)
        }));

        const result = await sbFetch('wishlist_items?on_conflict=id', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(formatted)
        });

        if (!result.ok) return res.status(500).json({ ok: false, error: JSON.stringify(result.data) });
        return res.status(200).json({ ok: true, data: result.data });
      }

      if (req.method === 'DELETE' && id) {
        const result = await sbFetch(`wishlist_items?id=eq.${encodeURIComponent(id)}`, {
          method: 'DELETE'
        });
        if (!result.ok) return res.status(500).json({ ok: false, error: JSON.stringify(result.data) });
        return res.status(200).json({ ok: true });
      }
    }

    // 2. CANLI ARAMA ÖNERİLERİ (?q=...)
    if (q) {
      const query = encodeURIComponent(q.trim());
      const [suggestRes, ddgRes] = await Promise.allSettled([
        fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=tr&q=${query}`),
        fetch(`https://duckduckgo.com/ac/?q=${query}&kl=tr-tr`)
      ]);

      let suggestions = [];
      if (suggestRes.status === 'fulfilled' && suggestRes.value.ok) {
        const data = await suggestRes.value.json();
        if (Array.isArray(data[1])) suggestions.push(...data[1]);
      }
      if (ddgRes.status === 'fulfilled' && ddgRes.value.ok) {
        const data = await ddgRes.value.json();
        if (Array.isArray(data)) suggestions.push(...data.map(item => item.phrase));
      }

      const uniqueSuggestions = [...new Set(suggestions)].slice(0, 6);
      const items = uniqueSuggestions.map(title => ({
        title,
        image: `https://tse2.mm.bing.net/th?q=${encodeURIComponent(title)}&w=400&h=400&c=7&rs=1&p=0`,
        searchUrl: `https://www.akakce.com/arama/?q=${encodeURIComponent(title)}`
      }));

      return res.status(200).json({ ok: true, items });
    }

    // 3. ÜRÜN LİNKİNDEN VERİ ÇEKME (?url=...)
    if (url) {
      let targetUrl = new URL(url).toString();
      const asinMatch = targetUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);

      if (targetUrl.includes('amazon.') && asinMatch) {
        const baseHost = new URL(targetUrl).host;
        targetUrl = `https://${baseHost}/dp/${asinMatch[1]}`;
      }

      const decodeHtml = (str) =>
        str.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

      const response = await fetch(targetUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache'
        }
      });

      const finalUrl = response.url || targetUrl;
      const html = await response.text();

      const isBlocked =
        response.status === 403 ||
        response.status === 503 ||
        html.includes('Üzgünüz') ||
        html.includes('Hepsiburada Güvenlik') ||
        html.includes('api-services-support@amazon.com') ||
        html.includes('Güvenlik Doğrulaması') ||
        html.includes('cf-browser-verification');

      let title = '';
      let image = '';
      let price = '';

      if (!isBlocked) {
        const getMeta = (prop) => {
          const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
          const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
          const m = html.match(r1) || html.match(r2);
          return m ? decodeHtml(m[1]) : '';
        };

        title = getMeta('og:title') || getMeta('twitter:title') || '';
        image = getMeta('og:image') || getMeta('twitter:image') || '';
        price = getMeta('product:price:amount') || getMeta('og:price:amount') || '';

        if (!title) {
          const tm = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (tm) title = decodeHtml(tm[1].trim());
        }

        if (finalUrl.includes('amazon.')) {
          const pTitle = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
          if (pTitle) title = decodeHtml(pTitle[1].replace(/<[^>]+>/g, '').trim());

          const pImg = html.match(/id=["']landingImage["'][^>]+src=["']([^"']+)["']/i) ||
                       html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i) ||
                       html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i);
          if (pImg) image = pImg[1];

          const pPrice = html.match(/class=["']a-price-whole["'][^>]*>([\d.,]+)/i);
          if (pPrice) price = pPrice[1];
        }

        const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of jsonLdMatches) {
          try {
            const parsed = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi, '').trim());
            const list = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
            const product = list.find(x => x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product')));
            if (product) {
              if (product.name) title = decodeHtml(product.name);
              if (product.image) image = Array.isArray(product.image) ? product.image[0] : (product.image.url || product.image);
              if (product.offers) {
                const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
                const rawPrice = offer.price || offer.lowPrice || '';
                if (rawPrice) price = String(rawPrice);
              }
            }
          } catch (_) {}
        }
      }

      // 1. Kurtarma: Amazon ASIN kodu ile arama
      const finalAsin = finalUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if ((isBlocked || !title || title.toLowerCase().includes('üzgünüz')) && finalAsin) {
        try {
          const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"amazon.com.tr" "${finalAsin[1]}"`)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const ddgHtml = await ddgRes.text();
          const resultTitle = ddgHtml.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
          if (resultTitle) {
            title = decodeHtml(resultTitle[1].replace(/<[^>]+>/g, '').trim());
          }
          const snippetPrice = ddgHtml.match(/([\d.]+(?:,\d{2})?)\s*(?:TL|₺)/i);
          if (snippetPrice && !price) price = snippetPrice[1];
        } catch (_) {}
      }

      // 2. Kurtarma: Hepsiburada ürün kodu (HBCV...) veya yönlenen URL slug'ı ile kurtarma
      if ((isBlocked || !title || title.toLowerCase().includes('güvenlik')) && (finalUrl.includes('hepsiburada.com') || targetUrl.includes('hb.biz'))) {
        const hbCodeMatch = finalUrl.match(/-(?:p|pm)-([A-Z0-9]+)/i);
        if (hbCodeMatch) {
          try {
            const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"hepsiburada.com" "${hbCodeMatch[1]}"`)}`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            const ddgHtml = await ddgRes.text();
            const resultTitle = ddgHtml.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
            if (resultTitle) {
              title = decodeHtml(resultTitle[1].replace(/<[^>]+>/g, '').trim());
            }
            const snippetPrice = ddgHtml.match(/([\d.]+(?:,\d{2})?)\s*(?:TL|₺)/i);
            if (snippetPrice && !price) price = snippetPrice[1];
          } catch (_) {}
        }

        if (!title || title.toLowerCase().includes('güvenlik')) {
          const slugMatch = new URL(finalUrl).pathname.match(/^\/([a-z0-9-]+?)-(?:p|pm)-[a-z0-9]+/i);
          if (slugMatch) {
            title = slugMatch[1]
              .split('-')
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');
          }
        }
      }

      if (title && !image && !title.toLowerCase().includes('güvenlik') && !title.toLowerCase().includes('üzgünüz')) {
        image = `https://tse2.mm.bing.net/th?q=${encodeURIComponent(title)}&w=400&h=400&c=7&rs=1&p=0`;
      }

      if (image && image.startsWith('/')) {
        const base = new URL(finalUrl);
        image = `${base.protocol}//${base.host}${image}`;
      }

      let numericPrice = 0;
      if (price) {
        const cleaned = String(price).replace(/[^\d.,]/g, '').replace(/[.,]$/, '');
        if (cleaned.includes(',') && cleaned.includes('.')) {
          numericPrice = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
        } else if (cleaned.includes(',')) {
          numericPrice = parseFloat(cleaned.replace(',', '.'));
        } else {
          numericPrice = parseFloat(cleaned);
        }
      }

      title = title
        .replace(/^Amazon\.com\.tr\s*:\s*/i, '')
        .replace(/\s*[-|•:]\s*(Trendyol|Hepsiburada(?:\.com)?|Amazon\.com\.tr|n11|Akakçe|Çiçeksepeti).*$/i, '')
        .trim();

      if (!title || title.toLowerCase().includes('üzgünüz') || title.toLowerCase().includes('güvenlik')) {
        return res.status(200).json({
          ok: false,
          error: 'Mağaza güvenlik koruması nedeniyle otomatik okunamadı; ürün adını yukarıdaki kutuya yazarak arayabilirsin.'
        });
      }

      return res.status(200).json({
        ok: true,
        title,
        image,
        price: isNaN(numericPrice) ? 0 : Math.round(numericPrice)
      });
    }

    return res.status(400).json({ ok: false, error: 'Geçersiz istek.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
