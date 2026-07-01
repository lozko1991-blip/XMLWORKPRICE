// ============================================================
// websklad-processor.js
// Завантажує прайс websklad.biz.ua, трансформує і зберігає
// websklad.xml (запускається GitHub Actions кожні 4 год)
// Node.js 20+, без зовнішніх залежностей, ES Modules
// ============================================================

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Налаштування ─────────────────────────────────────────────────────────────
const SOURCE_URL = 'https://www.websklad.biz.ua/wp-content/uploads/randomize_prom_84230.xml';
const OUT_FILE   = 'websklad.xml';   // зберігається у кореневій теці (feeds гілка)
const MIN_PRICE  = 150;              // товари дешевші → видаляємо

// ─── HTTP fetch з підтримкою редіректів ──────────────────────────────────────
function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Забагато редіректів'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'websklad-processor/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// ─── XML-екранування ──────────────────────────────────────────────────────────
function escapeXml(t) {
  return String(t)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── CDATA + HTML → plain text ────────────────────────────────────────────────
function stripCdata(xml) {
  return xml.replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/g, '');
}

function stripHtml(html) {
  return html
    .replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r?\n([ \t]*\r?\n)+/g, '\n')
    .replace(/ \n/g, '\n').replace(/\n /g, '\n')
    .trim();
}

// ─── Шумові патерни (УК + РУ) ─────────────────────────────────────────────────
const NOISE_MARKERS = ['🔴', '🎯', '👇', '👉', 'відео розп', 'видео расп', 'отримаєте такий', 'получите такой', 'отримаєте товар', 'получите товар'];

const NOISE_RE = [
  /🔴[^🔴\n]{0,80}(?:ВІДЕО|ВИДЕО)\s+(?:РОЗПАКОВКИ|РАСПАКОВКИ)[^🔴\n]{0,80}🔴/gi,
  /🎯[^🎯\n]{0,100}(?:відео|видео)[^🎯\n]{0,30}/gi,
  /[👇👉][^👇👉\n]{0,70}(?:Детальніше|Подробнее|Детальнее)[^👇👉\n]{0,30}[👇👉]/gi,
  /[👇👉][^👇👉\n]{0,80}(?:видео|открыть)[^👇👉\n]{0,30}/gi,
  /(?:відео|видео)\s+(?:розпаковки|распаковки|передоплата|предоплата|запись)\b[^\n]*/gi,
  /(?:🎯|✨)?\s*(?:Ви\s+отримаєте|Вы\s+получите)\s+(?:такий|такой)\s+товар[,\s]+(?:як|как)\s+на\s+(?:відео|видео)\s*!?\s*(?:👇)?/gi,
];

// ─── Очистка опису — ЗАВЖДИ очищаємо HTML (GitHub Actions, немає ліміту CPU) ──
function cleanDescription(offerXml) {
  // Без early-exit: кожен оффер очищається від HTML → правильний XML
  // (early-exit був потрібен тільки для Cloudflare, тут він шкодить)
  return offerXml.replace(
    /(<(?:description|description_ua|body|body_ua)\b[^>]*>)([\s\S]*?)(<\/(?:description|description_ua|body|body_ua)>)/gi,
    (full, open, content, close) => {
      let text = stripCdata(content);
      text = stripHtml(text);
      // Видаляємо шумові фрази тільки якщо вони є
      if (NOISE_MARKERS.some(m => text.includes(m))) {
        for (const re of NOISE_RE) text = text.replace(re, '');
      }
      text = text.replace(/[ \t]{2,}/g, ' ').trim();
      return `${open}${escapeXml(text)}${close}`;
    }
  );
}

// ─── Бренд / Колір ───────────────────────────────────────────────────────────
function normalizeBrand(v) {
  const s = (v ?? '').trim();
  if (!s) return 'No Brand';
  if (['без бренда','без бренду','no brand','n/a','none'].includes(s.toLowerCase()))
    return 'No Brand';
  return s;
}

function normalizeColor(v) {
  return (v ?? '').trim() || 'Комбінований';
}

// ─── Читаємо <param name="..."> ──────────────────────────────────────────────
function extractParam(offerXml, names) {
  for (const n of names) {
    const re = new RegExp(`<param\\s+name="${escapeRe(n)}"\\s*>([\\s\\S]*?)<\\/param>`, 'i');
    const m = offerXml.match(re);
    if (m) return String(m[1] ?? '').replace(/<[^>]+>/g, '').trim();
  }
  return null;
}

// ─── Вставляємо/заповнюємо тег ───────────────────────────────────────────────
function upsertTag(offerXml, tag, value) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  if (re.test(offerXml))
    return offerXml.replace(re, (full, inner) =>
      String(inner ?? '').trim() ? full : `<${tag}>${escapeXml(value)}</${tag}>`);
  return offerXml.replace(/<\/offer>\s*$/i, `<${tag}>${escapeXml(value)}</${tag}></offer>`);
}

// ─── Size ─────────────────────────────────────────────────────────────────────
function ensureSize(offerXml) {
  const reTag   = /<size\b[^>]*>([\s\S]*?)<\/size>/i;
  const reParam = /<param\s+name="(?:Розмір|Размер|Size)"[\s\S]*?<\/param>/i;
  if (reTag.test(offerXml))
    return offerXml.replace(reTag, (full, inner) =>
      String(inner ?? '').trim() ? full : '<size>Universal</size>');
  if (reParam.test(offerXml)) return offerXml;
  return offerXml.replace(/<\/offer>\s*$/i, '<size>-</size></offer>');
}

// ─── Ціна +50 грн якщо < 600 ─────────────────────────────────────────────────
function applyMarkup(offerXml) {
  const re = /<price\b[^>]*>([\s\S]*?)<\/price>/i;
  const m = offerXml.match(re);
  if (!m) return offerXml;
  const p = Number(String(m[1] ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(p) || p >= 600) return offerXml;
  return offerXml.replace(re, `<price>${Math.round(p + 50)}</price>`);
}

// ─── Допоміжні фільтри ────────────────────────────────────────────────────────
function getPrice(offerXml) {
  const m = offerXml.match(/<price\b[^>]*>([\s\S]*?)<\/price>/i);
  if (!m) return null;
  const p = Number(String(m[1] ?? '').trim().replace(',', '.'));
  return Number.isFinite(p) ? p : null;
}

function isAvailable(offerXml) {
  if (/\bavailable\s*=\s*["']false["']/i.test(offerXml)) return false;
  const m = offerXml.match(/<available\b[^>]*>([\s\S]*?)<\/available>/i);
  return !(m && String(m[1]).trim().toLowerCase() === 'false');
}

// ─── Обробка одного офера ─────────────────────────────────────────────────────
function processOffer(offerXml) {
  let out = stripCdata(offerXml);
  
  // Додаємо префікс 1818 до offer id, щоб уникнути дублів
  out = out.replace(/(<offer\b[^>]*\bid=")([^"]+)(")/i, (m, prefix, id, suffix) => prefix + '1818' + id + suffix);

  out = cleanDescription(out);
  out = applyMarkup(out);

  const brand = extractParam(out, ['Бренд','Brand','Производитель','Виробник']) ?? '';
  out = upsertTag(out, 'brand', normalizeBrand(brand));
  out = upsertTag(out, 'vendor', 'Brand');

  const color = extractParam(out, ['Колір','Цвет','Color']) ?? '';
  out = upsertTag(out, 'color', normalizeColor(color));

  out = ensureSize(out);
  return out;
}

// ─── Головна функція ──────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] Завантаження: ${SOURCE_URL}`);

  const xml = await fetchUrl(SOURCE_URL);
  console.log(`Завантажено: ${Math.round(xml.length / 1024)} КБ`);

  let kept = 0, skipUnavail = 0, skipCheap = 0;

  const result = xml.replace(/<offer[\s\S]*?<\/offer>/gi, offer => {
    if (!isAvailable(offer))                        { skipUnavail++; return ''; }
    const p = getPrice(offer);
    if (p !== null && p < MIN_PRICE)                { skipCheap++;   return ''; }
    kept++;
    return processOffer(offer);
  });

  fs.writeFileSync(OUT_FILE, result, 'utf8');

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✅ ${OUT_FILE} збережено (${Math.round(result.length / 1024)} КБ)`);
  console.log(`   Залишено: ${kept} | Не в наявності: ${skipUnavail} | Дешевших ${MIN_PRICE}₴: ${skipCheap}`);
  console.log(`   Час: ${sec}с`);
}

main().catch(e => { console.error(e); process.exit(1); });
