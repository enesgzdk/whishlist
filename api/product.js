// api/product.js
export default async function handler(req, res) {
  // GitHub Pages'ten gelen isteklere izin ver (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, q } = req.query;

  // 1. DURUM: Canlı Arama & Tahmini Seçenekler (?q=airpods pro 3)
  if (q) {
    try {
      const query = encodeURIComponent(q.trim());
      // Google / DuckDuckGo canlı arama önerileri + görsel arama sonuçları
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
        if (Array.isArray(data)) {
          suggestions.push(...data.map(item => item.phrase));
        }
      }

      // Tekrarları temizle ve ilk 6 öneriyi al
      const uniqueSuggestions = [...new Set(suggestions)].slice(0, 6);

      // En iyi eşleşme için Bing/Web görsel önizleme URL'i oluştur
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

  // 2. DURUM: Ürün Linkinden Görsel, Başlık ve Fiyat Çekme (?url=https://...)
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

      const getMeta = (prop) => {
        const regex1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
        const regex2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
        const match = html.match(regex1) || html.match(regex2);
        return match ? decodeHtml(match[1]) : '';
      };

      const decodeHtml = (str) =>
        str.replace(/&amp;/g, '&')
           .replace(/&quot;/g, '"')
           .replace(/&#39;/g, "'")
           .replace(/&lt;/g, '<')
           .replace(/&gt;/g, '>');

      let title = getMeta('og:title') || getMeta('twitter:title') || '';
      let image = getMeta('og:image') || getMeta('twitter:image') || '';
      let price = getMeta('product:price:amount') || getMeta('og:price:amount') || '';

      // HTML <title> fallback
      if (!title) {
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) title = decodeHtml(titleMatch[1].trim());
      }

      // JSON-LD (Schema.org Product) içinden daha temiz başlık, görsel ve fiyat yakalama
      const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const block of jsonLdMatches) {
        try {
          const rawJson = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
          const parsed = JSON.parse(rawJson);
          const list = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
          const product = list.find(x => x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product')));

          if (product) {
            if (product.name) title = decodeHtml(product.name);
            if (product.image) {
              image = Array.isArray(product.image) ? product.image[0] : (product.image.url || product.image);
            }
            if (product.offers) {
              const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
              const rawPrice = offer.price || offer.lowPrice || '';
              if (rawPrice) price = String(rawPrice);
            }
          }
        } catch (_) {}
      }

      // Görsel göreli yol (/images/...) ise tam URL yap
      if (image && image.startsWith('/')) {
        const base = new URL(targetUrl);
        image = `${base.protocol}//${base.host}${image}`;
      }

      // Fiyatı temiz sayıya çevir (Örn: "12.499,90" -> 12499.9)
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

      // Site sonundaki gereksiz "- Trendyol", "| Hepsiburada" eklerini temizle
      title = title.replace(/\s*[-|•]\s*(Trendyol|Hepsiburada|Amazon\.com\.tr|n11|Akakçe|Çiçeksepeti).*$/i, '').trim();

      return res.status(200).json({
        ok: true,
        title,
        image,
        price: isNaN(numericPrice) ? 0 : Math.round(numericPrice)
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        error: 'Site bot koruması nedeniyle otomatik çekilemedi, bilgileri elle girebilirsin.'
      });
    }
  }

  return res.status(400).json({ ok: false, error: 'url veya q parametresi gerekli.' });
}
