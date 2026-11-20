// api/product.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-pin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SYNC_PIN = process.env.SYNC_PIN || '';

  const sbFetch = async (path, options = {}) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : null };
  };

  const { action, url, q, id } = req.query;

  // 1. SUPABASE VERİTABANI İŞLEMLERİ
  if (action === 'list' || req.method === 'POST' || req.method === 'DELETE') {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ ok: false, error: 'Vercel üzerinde SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY eksik.' });
    }

    if (SYNC_PIN && req.headers['x-sync-pin'] !== SYNC_PIN) {
      return res.status(401).json({ ok: false, error: 'Hatalı Senkronizasyon PIN kodu.' });
    }

    if (req.method === 'GET' && action === 'list') {
      const result = await sbFetch('wishlist_items?select=*&order=created_at.desc');
      return res.status(result.ok ? 200 : 500).json({ ok: result.ok, items: result.data || [] });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
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

      return res.status(result.ok ? 200 : 500).json({ ok: result.ok, data: result.data });
    }

    if (req.method === 'DELETE' && id) {
      const result = await sbFetch(`wishlist_items?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      return res.status(result.ok ? 200 : 500).json({ ok: result.ok });
    }
  }

  // 2. CANLI ARAMA ÖNERİLERİ (?q=...)
  if (q) {
    try {
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
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Arama önerileri alınamadı.' });
    }
  }

  // 3. ÜRÜN LİNKİNDEN GÖRSEL, BAŞLIK VE FİYAT ÇEKME (?url=...)
  if (url) {
    try {
      const targetUrl = new URL(url).toString();
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });

      const html = await response.text();
      const decodeHtml = (str) =>
        str.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

      const getMeta = (prop) => {
        const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
        const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
        const m = html.match(r1) || html.match(r2);
        return m ? decodeHtml(m[1]) : '';
      };

      let title = getMeta('og:title') || getMeta('twitter:title') || '';
      let image = getMeta('og:image') || getMeta('twitter:image') || '';
      let price = getMeta('product:price:amount') || getMeta('og:price:amount') || '';

      if (!title) {
        const tm = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (tm) title = decodeHtml(tm[1].trim());
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

      if (image && image.startsWith('/')) {
        const base = new URL(targetUrl);
        image = `${base.protocol}//${base.host}${image}`;
      }

      let numericPrice = 0;
      if (price) {
        const cleaned = String(price).replace(/[^\d.,]/g, '');
        if (cleaned.includes(',') && cleaned.includes('.')) {
          numericPrice = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
        } else if (cleaned.includes(',')) {
          numericPrice = parseFloat(cleaned.replace(',', '.'));
        } else {
          numericPrice = parseFloat(cleaned);
        }
      }

      title = title.replace(/\s*[-|•]\s*(Trendyol|Hepsiburada|Amazon\.com\.tr|n11|Akakçe|Çiçeksepeti).*$/i, '').trim();

      return res.status(200).json({
        ok: true,
        title,
        image,
        price: isNaN(numericPrice) ? 0 : Math.round(numericPrice)
      });
    } catch (err) {
      return res.status(200).json({ ok: false, error: 'Site bot koruması nedeniyle otomatik çekilemedi.' });
    }
  }

  return res.status(400).json({ ok: false, error: 'Geçersiz istek.' });
}
