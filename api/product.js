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

    // ==========================================
    // 1. SUPABASE VERİTABANI İŞLEMLERİ
    // ==========================================
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

    // ==========================================
    // 2. CANLI ARAMA ÖNERİLERİ (?q=...)
    // ==========================================
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

    // ==========================================
    // 3. ÜRÜN LİNKİNDEN VERİ ÇEKME (?url=...)
    // ==========================================
    if (url) {
      let targetUrl = new URL(url).toString();
      const asinMatch = targetUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);

      if (targetUrl.includes('amazon.') && asinMatch) {
        const baseHost = new URL(targetUrl).host;
        targetUrl = `https://${baseHost}/dp/${asinMatch[1]}`;
      }

      const isBlockedText = (txt) => {
        if (!txt) return true;
        const low = txt.toLowerCase();
        return (
          low.includes('üzgünüz') ||
          low.includes('güvenlik') ||
          low.includes('robot') ||
          low.includes('captcha') ||
          low.includes('access denied') ||
          low.includes('just a moment') ||
          low === 'amazon.com.tr' ||
          low === 'hepsiburada' ||
          low === 'trendyol'
        );
      };

      let title = '';
      let image = '';
      let price = '';
      let resolvedUrl = targetUrl;

      // KATMAN 1: Microlink Headless Metadata API (Bot korumalarını gerçek tarayıcı IP'siyle aşar)
      try {
        const mlRes = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`);
        if (mlRes.ok) {
          const mlJson = await mlRes.json();
          if (mlJson.status === 'success' && mlJson.data) {
            const d = mlJson.data;
            if (d.url) resolvedUrl = d.url;
            if (d.title && !isBlockedText(d.title)) title = d.title;
            if (d.image && d.image.url) image = d.image.url;
            if (d.description) {
              const descPrice = d.description.match(/([\d.]+(?:,\d{2})?)\s*(?:TL|₺)/i);
              if (descPrice) price = descPrice[1];
            }
          }
        }
      } catch (_) {}

      // KATMAN 2: Jina Reader Proxy (Eğer başlık veya fiyat eksik kaldıysa)
      if (!title || isBlockedText(title) || !price) {
        try {
          const jinaRes = await fetch(`https://r.jina.ai/${resolvedUrl}`, {
            headers: { 'Accept': 'text/plain' }
          });
          if (jinaRes.ok) {
            const md = await jinaRes.text();
            const titleLine = md.match(/^Title:\s*(.+)$/m);
            if (titleLine && !isBlockedText(titleLine[1].trim()) && (!title || isBlockedText(title))) {
              title = titleLine[1].trim();
            }
            if (!price && !isBlockedText(md.slice(0, 500))) {
              const mdPrice = md.match(/([\d.]{2,}(?:,\d{2})?)\s*(?:TL|₺)/i);
              if (mdPrice) price = mdPrice[1];
            }
            if (!image) {
              const imgMatch = md.match(/!\[[^\]]*\]\((https:\/\/[^)]+\.(?:jpg|jpeg|png|webp)[^)]*)\)/i);
              if (imgMatch && !imgMatch[1].includes('logo') && !imgMatch[1].includes('icon')) {
                image = imgMatch[1];
              }
            }
          }
        } catch (_) {}
      }

      // KATMAN 3: URL Slug'ından Ürün Adı Kurtarma (app.hb.biz -> hepsiburada.com/urun-adi-p-HBCV... vb.)
      if (!title || isBlockedText(title)) {
        try {
          const parsedUrl = new URL(resolvedUrl);
          // Hepsiburada slug: /urun-adi-p-HBCV...
          const hbSlug = parsedUrl.pathname.match(/^\/([a-z0-9-]+?)-(?:p|pm)-[a-z0-9]+/i);
          // Trendyol slug: /marka/urun-adi-p-123456
          const tySlug = parsedUrl.pathname.match(/\/([a-z0-9-]+?)-p-\d+/i);
          const slug = (hbSlug && hbSlug[1]) || (tySlug && tySlug[1]);
          if (slug) {
            title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          }
        } catch (_) {}
      }

      // Temizlik ve Son Kontroller
      title = title
        .replace(/^Amazon\.com\.tr\s*:\s*/i, '')
        .replace(/\s*[-|•:]\s*(Trendyol|Hepsiburada(?:\.com)?|Amazon\.com\.tr|n11|Akakçe|Çiçeksepeti|Fiyatı, Yorumları).*$/i, '')
        .trim();

      if (title && !isBlockedText(title) && !image) {
        image = `https://tse2.mm.bing.net/th?q=${encodeURIComponent(title)}&w=400&h=400&c=7&rs=1&p=0`;
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

      if (!title || isBlockedText(title)) {
        return res.status(200).json({
          ok: false,
          error: 'Linkteki bilgi okunamadı, ürün adını yukarıdaki kutuya yazarak arayabilirsin.'
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
