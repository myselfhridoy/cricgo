/**
 * GitHub Actions scraper
 * - Bypass Cloudflare via Puppeteer
 * - Get fid for each slug
 * - Get signed m3u8 URL
 * - POST results to InfinityFree
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// ============================================================
// EDIT THIS: your channels (slug used in ?id=)
// ============================================================
const CHANNELS = [
  'willow',
  'willow-2',
  'star-sports-1',
  'star-sports-1-hindi',
  'star-sports-2',
  'ptv-sports',
  'a-sports',
  'ten-sports',
  't-sports',
  'geo-super',
  'astro-cricket',
  'fox-sports-cricket',
  'sony-sports-ten-5',
  'sony-sports-ten-1',
  'sony-sports-ten-2',
  'sony-sports-ten-3',
  'sky-sports-cricket',
  'supersport-cricket',
];

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

const UPDATE_URL = process.env.UPDATE_URL;   // https://your-site/cricgo/player.php?action=update
const UPDATE_KEY = process.env.UPDATE_KEY;   // secret from GitHub secrets

if (!UPDATE_URL || !UPDATE_KEY) {
  console.error('Missing UPDATE_URL or UPDATE_KEY');
  process.exit(1);
}

// ============================================================
// Extract fid from cricgo.cc HTML
// ============================================================
function extractFid(html) {
  let m = html.match(/playerso\.top\/embedit\.php\?id=([a-z0-9]+)/i);
  if (m) return m[1];
  m = html.match(/\bfid\s*=\s*["']([a-z0-9]+)["']/i);
  if (m) return m[1];
  m = html.match(/\bv_id\s*=\s*["']([a-z0-9]+)["']/i);
  if (m) return m[1];
  return null;
}

// ============================================================
// Extract signed m3u8 URL from playerr03.com HTML
// ============================================================
function extractM3u8(html) {
  // Base server: var X = 'mz02.play' + 'err03.com' + ':7060';
  let base = null;
  let bm = html.match(/var\s+\w+\s*=\s*'([^']+)'\s*\+\s*'([^']+)'\s*\+\s*'([^']+)'/);
  if (bm) base = bm[1] + bm[2] + bm[3];

  // Char array: ["h","t","t","p",...].join("")
  let path = null;
  let am = html.match(/\[\s*("[^]]+")\s*\]\s*\.join\(""\)/);
  if (am) {
    try {
      const parts = JSON.parse('[' + am[1] + ']');
      path = parts.join('');
    } catch (e) { /* ignore */ }
  }

  if (base && path) {
    const url = 'https://' + base + path;
    if (url.includes('.m3u8')) return url;
  }

  // Fallback: any m3u8 URL
  let fm = html.match(/(https?:\/\/[^"']+\.m3u8\?[^"']+)/);
  if (fm) return fm[1];

  return null;
}

// ============================================================
// Scrape one channel
// ============================================================
async function scrapeOne(browser, slug) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA_MOBILE);
    await page.setViewport({ width: 412, height: 915, isMobile: true });

    // ---- Step A: cricgo.cc player page → fid ----
    await page.goto(`https://cricgo.cc/player.php?id=${slug}`, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Extra wait for CF challenge to auto-solve
    await new Promise(r => setTimeout(r, 4000));

    let html = await page.content();

    // CF challenge detected? wait more
    if (/Just a moment|challenge-platform|cf-chl/i.test(html)) {
      await new Promise(r => setTimeout(r, 8000));
      html = await page.content();
    }

    const fid = extractFid(html);
    if (!fid) {
      console.log(`❌ ${slug}: fid not found`);
      return null;
    }

    // ---- Step B: playerr03.com → m3u8 ----
    const embedRes = await axios.get(
      `https://playerr03.com/embed.php?v=${fid}`,
      {
        headers: {
          'User-Agent': UA_MOBILE,
          'Referer': 'https://playerso.top/',
          'Origin': 'https://playerr03.com',
        },
        timeout: 20000,
        validateStatus: () => true,
      }
    );

    const m3u8 = extractM3u8(embedRes.data || '');
    if (!m3u8) {
      console.log(`⚠️ ${slug}: fid=${fid} but no m3u8`);
      return { fid, m3u8: null };
    }

    console.log(`✅ ${slug}: fid=${fid}, m3u8 OK`);
    return { fid, m3u8 };
  } catch (e) {
    console.log(`❌ ${slug}: ${e.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ============================================================
// MAIN
// ============================================================
(async () => {
  console.log(`🚀 Scraping ${CHANNELS.length} channels...`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const results = {};
  let ok = 0;

  for (const slug of CHANNELS) {
    const r = await scrapeOne(browser, slug);
    if (r && r.m3u8) {
      results[slug] = r;
      ok++;
    }
    // polite delay
    await new Promise(res => setTimeout(res, 800));
  }

  await browser.close();
  console.log(`\n📊 Success: ${ok}/${CHANNELS.length}`);

  if (ok === 0) {
    console.error('❌ Nothing scraped, aborting push');
    process.exit(1);
  }

  // POST to InfinityFree
  try {
    const res = await axios.post(UPDATE_URL, results, {
      headers: {
        'Content-Type': 'application/json',
        'X-Update-Key': UPDATE_KEY,
      },
      timeout: 30000,
    });
    console.log('✅ Pushed:', res.data);
  } catch (e) {
    console.error('❌ Push failed:', e.message);
    process.exit(1);
  }
})();
