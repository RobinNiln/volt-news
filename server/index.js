const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');

const app = express();
const parser = new Parser({ timeout: 10000 });
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json());

// ── Storage ──────────────────────────────────────────────────
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');

function readArticles() {
  try { if (fs.existsSync(ARTICLES_FILE)) return JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8')); }
  catch(e) { console.error('Read error:', e.message); }
  return [];
}
function writeArticles(arts) {
  try { fs.writeFileSync(ARTICLES_FILE, JSON.stringify(arts, null, 2)); }
  catch(e) { console.error('Write error:', e.message); }
}
function saveArticle(a) {
  const arts = readArticles();
  const idx = arts.findIndex(x => x.id === a.id);
  if (idx >= 0) arts[idx] = a; else arts.unshift(a);
  writeArticles(arts);
}
function updateArticle(id, updates) {
  const arts = readArticles();
  const idx = arts.findIndex(x => x.id === id);
  if (idx >= 0) { Object.assign(arts[idx], updates); writeArticles(arts); }
}

// ── Sources ───────────────────────────────────────────────────
const SOURCES = {
  // Riksmedier
  aftonbladet: { name:'Aftonbladet', code:'AB',  color:'#e8001a', type:'riks', url:'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/' },
  expressen:   { name:'Expressen',   code:'EX',  color:'#006AA7', type:'riks', url:'https://feeds.expressen.se/nyheter/' },
  dn:          { name:'DN',          code:'DN',  color:'#1a1a1a', type:'riks', url:'https://www.dn.se/rss/' },
  svd:         { name:'SvD',         code:'SvD', color:'#002E6E', type:'riks', url:'https://www.svd.se/feed/articles.rss' },
  sydsvenskan: { name:'Sydsvenskan', code:'SDS', color:'#D92B3A', type:'riks', url:'https://www.sydsvenskan.se/rss.xml' },
  barometern:  { name:'Barometern',  code:'BAR', color:'#2B6E3A', type:'riks', url:'https://www.barometern.se/rss/' },
  svt:         { name:'SVT Nyheter', code:'SVT', color:'#1A5276', type:'riks', url:'https://www.svt.se/nyheter/rss.xml' },
  svt_sport:   { name:'SVT Sport',   code:'SVTs',color:'#1A5276', type:'riks', cat:'sport', url:'https://www.svt.se/sport/rss.xml' },
  svt_noje:    { name:'SVT Nöje',    code:'SVTn',color:'#1A5276', type:'riks', cat:'noje', url:'https://www.svt.se/nyheter/inrikes/rss.xml' },
  ab_sport:    { name:'AB Sport',    code:'ABs', color:'#e8001a', type:'riks', cat:'sport', url:'https://rss.aftonbladet.se/rss2/small/pages/sections/sportbladet/' },
  ab_noje:     { name:'AB Nöje',     code:'ABn', color:'#e8001a', type:'riks', cat:'noje', url:'https://rss.aftonbladet.se/rss2/small/pages/sections/nojesbladet/' },
  ex_sport:    { name:'EX Sport',    code:'EXs', color:'#006AA7', type:'riks', cat:'sport', url:'https://feeds.expressen.se/sport/' },
  ex_noje:     { name:'EX Nöje',     code:'EXn', color:'#006AA7', type:'riks', cat:'noje', url:'https://feeds.expressen.se/noje/' },
  // Internationella källor
  nyt_world:   { name:'New York Times', code:'NYT', color:'#000', type:'intl', cat:'internationellt', url:'https://rss.nytimes.com/services/xml/rss/nyt/World.rss' },
  nyt_politics:{ name:'NYT Politics',   code:'NYTp',color:'#000', type:'intl', cat:'internationellt', url:'https://rss.nytimes.com/services/xml/rss/nyt/Politics.rss' },
  guardian_int:{ name:'The Guardian',   code:'GRD', color:'#052962', type:'intl', cat:'internationellt', url:'https://www.theguardian.com/world/rss' },
  guardian_eu: { name:'Guardian Europe',code:'GRDe',color:'#052962', type:'intl', cat:'internationellt', url:'https://www.theguardian.com/world/europe-news/rss' },
  bbc_world:   { name:'BBC News',       code:'BBC', color:'#b80000', type:'intl', cat:'internationellt', url:'http://feeds.bbci.co.uk/news/world/rss.xml' },
  reuters:     { name:'Reuters',        code:'REU', color:'#ff8000', type:'intl', cat:'internationellt', url:'https://feeds.reuters.com/reuters/worldNews' },
  // NTM — Norr
  norran:      { name:'Norran',      code:'NOR', color:'#C0392B', type:'ntm', region:'norr', url:'https://www.norran.se/rss/' },
  nsd:         { name:'NSD',         code:'NSD', color:'#C0392B', type:'ntm', region:'norr', url:'https://www.nsd.se/rss/' },
  norrbotten:  { name:'Norrbottens-Kuriren', code:'NK', color:'#C0392B', type:'ntm', region:'norr', url:'https://www.nk.se/rss/' },
  pitea:       { name:'Piteå-Tidningen', code:'PT', color:'#C0392B', type:'ntm', region:'norr', url:'https://www.pitea-tidningen.se/rss/' },
  // NTM — Mitt
  unt:         { name:'UNT',         code:'UNT', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.unt.se/rss/' },
  nt:          { name:'NT',          code:'NT',  color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.nt.se/rss/' },
  corren:      { name:'Corren',      code:'COR', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.corren.se/rss/' },
  sn:          { name:'SN',          code:'SN',  color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.sn.se/rss/' },
  strengnas:   { name:'Strengnäs Tidning', code:'ST', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.strengnas-tidning.se/rss/' },
  eskilstuna:  { name:'Eskilstuna-Kuriren', code:'EK', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.eskilstuna-kuriren.se/rss/' },
  enkoping:    { name:'Enköpings-Posten', code:'EP', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.enkopingsposten.se/rss/' },
  katrineholms:{ name:'Katrineholms-Kuriren', code:'KK', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.katrineholms-kuriren.se/rss/' },
  kuriren:     { name:'Kuriren',     code:'KUR', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.kuriren.nu/rss/' },
  mvt:         { name:'MVT',         code:'MVT', color:'#C0392B', type:'ntm', region:'mitt', url:'https://www.mvt.se/rss/' },
  // NTM — Syd/Öst
  gt:          { name:'GT',          code:'GT',  color:'#C0392B', type:'ntm', region:'syd', url:'https://www.gt.se/rss/' },
  helagotland: { name:'Hela Gotland', code:'HG', color:'#C0392B', type:'ntm', region:'syd', url:'https://www.helagotland.se/rss/' },
  gotlandsallehanda: { name:'Gotlands Allehanda', code:'GA', color:'#C0392B', type:'ntm', region:'syd', url:'https://www.gotlandsallehanda.se/rss/' },
  vimmerby:    { name:'Vimmerby Tidning', code:'VIM', color:'#C0392B', type:'ntm', region:'syd', url:'https://www.vimmerbytidning.se/rss/' },
  vasterviks:  { name:'Västerviks Tidningen', code:'VT', color:'#C0392B', type:'ntm', region:'syd', url:'https://www.vt.se/rss/' },
};

// ── RSS Fetch ─────────────────────────────────────────────────
async function fetchFeed(key, source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 15).map(item => ({
      id: item.guid || item.link,
      title: (item.title || '').trim(),
      description: item.contentSnippet || item.summary || '',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
      source: source.name,
      sourceCode: source.code,
      sourceColor: source.color,
      sourceType: source.type,
      sourceRegion: source.region || 'riks',
      sourceCat: source.cat || 'nyheter',
    }));
  } catch(e) {
    return [];
  }
}

async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    Object.entries(SOURCES).map(([k, s]) => fetchFeed(k, s))
  );
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

// ── Signal Clustering ─────────────────────────────────────────
// Groups articles by shared keywords to find overlapping stories
function clusterItems(items, categoryFilter) {
  const cutoff = Date.now() - 10 * 60 * 60 * 1000; // 10h
  let recent = items.filter(i => new Date(i.pubDate) > cutoff);
  if (categoryFilter) {
    const catMap = {
      sport: ['sport'],
      naringsliv: ['naringsliv','ekonomi'],
      ekonomi: ['naringsliv','ekonomi'],
      noje: ['noje'],
      nyheter: ['nyheter'],
    };
    const cats = catMap[categoryFilter.toLowerCase()] || [categoryFilter.toLowerCase()];
    const sportKeywords = /\b(match|mål|serie|division|spelat|träning|lag|spel|vm|em|nhl|nfl|nba|fotboll|hockey|tennis|golf|friidrott|simning|cykel|löp|tävl|spelare|tränare|coach|transfer|säsong|final|semifinal|turnering|cup|liga|poäng|tabell|placering|vann|förlorade|oavgjort|rekord|guldmedalj|silvermedalj|bronsmeda|olymp)\b/i;
    const bizKeywords = /\b(aktie|börsen|vinst|förlust|omsättning|resultat|rapport|kvartal|bokslut|vd|ceo|fusion|förvärv|börsnoterad|ipo|varslar|sparar|investering|fonder|ränta|inflation|kronkurs|exporterar|importerar|tillväxt|budget|skatt|tullar|moms|konjunktur|produktion|fabrik|leverantör|konkurs|rekonstruktion|omstrukturering)\b/i;
    const nojeKeywords = /\b(film|musik|konsert|album|singel|spelfilm|dokumentär|serie|tv-serie|premiär|bio|teater|opera|festival|artist|band|skådespel|regissör|nominerad|oscar|grammi|pris|utmärkelse|turné|spelning|celebrity|kändis|reality|streaming|netflix|spotify|hbo|disney)\b/i;
    if (cats.includes('sport')) {
      recent = recent.filter(i => i.sourceCat === 'sport' || sportKeywords.test(i.title));
    } else if (cats.includes('naringsliv') || cats.includes('ekonomi')) {
      recent = recent.filter(i => i.sourceCat === 'naringsliv' || bizKeywords.test(i.title));
    } else if (cats.includes('noje')) {
      recent = recent.filter(i => i.sourceCat === 'noje' || nojeKeywords.test(i.title));
    } else if (cats.includes('internationellt')) {
      recent = recent.filter(i => i.sourceCat === 'internationellt' || i.sourceType === 'intl');
    }
  }

  // Extract significant words (4+ chars, not stopwords)
  const stopwords = new Set(['från','till','efter','under','över','utan','inte','eller','även','samt','enligt','detta','dessa','alla','många','vara','hade','kommer','sedan','innan','genom','deras','deras','sigsjälv','men','och','att','det','den','som','för','med','har','han','hon','när','var','vid','mot','hos','kring','bland','trots','inför','anser']);
  
  function keywords(title) {
    return title.toLowerCase()
      .replace(/[–—\-:,."'!?()]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !stopwords.has(w));
  }

  // Build clusters
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < recent.length; i++) {
    if (used.has(i)) continue;
    const kw = keywords(recent[i].title);
    if (!kw.length) continue;

    const cluster = { items: [recent[i]], keywords: new Set(kw) };
    used.add(i);

    for (let j = i + 1; j < recent.length; j++) {
      if (used.has(j)) continue;
      const kw2 = keywords(recent[j].title);
      const overlap = kw2.filter(w => cluster.keywords.has(w));
      if (overlap.length >= 1) {
        cluster.items.push(recent[j]);
        kw2.forEach(w => cluster.keywords.add(w));
        used.add(j);
      }
    }

    if (cluster.items.length >= 2) clusters.push(cluster);
  }

  // Score each cluster
  return clusters.map(cl => {
    const sourceCodes = [...new Set(cl.items.map(i => i.sourceCode))];
    const sourceTypes = cl.items.map(i => i.sourceType);
    const regions = [...new Set(cl.items.map(i => i.sourceRegion).filter(r => r !== 'riks'))];
    
    const riksCount = sourceTypes.filter(t => t === 'riks').length;
    const ntmCount = sourceTypes.filter(t => t === 'ntm').length;
    
    // Score: NTM titles weighted 1.5x, geographic spread bonus
    const baseScore = riksCount + ntmCount * 1.5;
    const spreadBonus = regions.length >= 2 ? 1.3 : regions.length === 1 ? 1.1 : 1.0;
    const score = Math.round(baseScore * spreadBonus * 10);

    // Time gradient — how many articles in last 2h vs 2-10h
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const fresh = cl.items.filter(i => new Date(i.pubDate) > twoHoursAgo).length;
    const growing = fresh >= 2;

    // Representative headline — prefer riksmedia
    const riksItems = cl.items.filter(i => i.sourceType === 'riks');
    const lead = riksItems[0] || cl.items[0];

    return {
      id: 'sig-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
      headline: lead.title,
      keywords: [...cl.keywords].slice(0, 5),
      articleCount: cl.items.length,
      sourceCount: sourceCodes.length,
      sourceCodes,
      regions,
      riksCount,
      ntmCount,
      score,
      growing,
      freshCount: fresh,
      items: cl.items.slice(0, 8).map(i => ({
        title: i.title,
        link: i.link,
        source: i.source,
        code: i.sourceCode,
        color: i.sourceColor,
        type: i.sourceType,
        region: i.sourceRegion,
        pubDate: i.pubDate,
      })),
    };
  }).sort((a, b) => b.score - a.score).slice(0, 20);
}

// ── Unsplash ──────────────────────────────────────────────────
async function fetchUnsplashImage(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return '';
  try {
    const r = await fetch(
      'https://api.unsplash.com/photos/random?query=' + encodeURIComponent(query) +
      '&orientation=landscape&content_filter=high',
      { headers: { 'Authorization': 'Client-ID ' + key } }
    );
    if (!r.ok) return '';
    const d = await r.json();
    return d.urls?.regular || '';
  } catch(e) { return ''; }
}

// ── Claude ────────────────────────────────────────────────────
function stripJsonFences(s) {
  var r = s.trim();
  var start = r.indexOf('{');
  if (start < 0) return r;
  r = r.slice(start);
  // Find the matching closing brace
  var depth = 0;
  for (var i = 0; i < r.length; i++) {
    if (r[i] === '{') depth++;
    else if (r[i] === '}') { depth--; if (depth === 0) return r.slice(0, i + 1); }
  }
  return r;
}

async function analyzeSignals(signals, categoryFilter) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas');

  const top10 = signals.slice(0, 10);
  const signalText = top10.map(function(s, i) {
    return 'ID:' + s.id + ' (' + (i+1) + '). "' + s.headline + '" — ' + s.sourceCount + ' kallor (' + s.riksCount + ' riksmedier, ' + s.ntmCount + ' lokala)' + (s.growing ? ' VAXER' : '') + '\n   Kallor: ' + s.sourceCodes.join(', ') + '\n   Regioner: ' + (s.regions.length ? s.regions.join(', ') : 'rikstackande') + '\n   Artiklar: ' + s.items.slice(0,3).map(function(x){ return '"' + x.title + '"'; }).join(' | ');
  }).join('\n\n');

  const catInstruction = categoryFilter === 'internationellt'
    ? 'Fokusera ENBART pa internationella nyheter. Kallorna ar pa engelska men du ska skriva rubriker och vinklar pa svenska. Valj de 5 mest relevanta internationella nyheterna.'
    : categoryFilter
      ? 'Fokusera ENBART pa amnen inom: ' + categoryFilter + '. Valj de 5 mest relevanta signalerna inom detta omrade.'
      : 'Valj de 5 mest varda att bevaka ur ett nationellt perspektiv. En lokal handelse som rapporteras i flera regioner ar en nationell historia.';
  const prompt = 'Du ar chefsredaktor pa GRID, en nationell nyhetstjanst. Nedan ar de starkaste nyhetssignalerna just nu baserade pa vad svenska medier skriver om.\n\n' + signalText + '\n\n' + catInstruction + '\n\nSvara ENDAST med JSON:\n{\n  "trends": [\n    {\n      "signalId": "ID-stringen fran signalen ovan",\n      "headline": "Konkret rubrik max 10 ord",\n      "angle": "Varfor detta ar en nationell nyhet i en mening",\n      "category": "Politik|Ekonomi|Samhalle|Industri|Klimat|Sport|Naringsliv|Kultur",\n      "imageQuery": "2-3 engelska ord for bildsokning"\n    }\n  ]\n}';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const d = await r.json();
  const text = stripJsonFences(d.content[0].text);
  return JSON.parse(text);
}


async function generateDraft(signal, trend) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas');

  if (!signal || !signal.items || !signal.items.length) {
    return res ? res.status(500).json({ error: 'Signal saknas' }) : null;
  }
  const sourceList = signal.items.map(function(i) {
    return '[' + i.source + '] "' + i.title + '"' + (i.link ? '\n   Lank: ' + i.link : '');
  }).join('\n\n');

  const isIntl = signal.items && signal.items.some(function(i){ return i.sourceType === 'intl'; });
  const langNote = isIntl ? ' Kallorna ar pa engelska - oversatt och skriv artikeln pa svenska.' : '';
  const prompt = 'Du ar erfaren nyhetsjournalist pa GRID, en svensk nationell nyhetssajt.' + langNote + '\n\nHar ar vad medier rapporterar just nu:\n\n' + sourceList + '\n\nDin uppgift: Skriv en nyhetsartikel baserad ENBART pa vad som faktiskt rapporteras ovan.\n- Anvand konkreta detaljer, namn, platser och siffror fran rubrikerna\n- Hittar du inte ett faktum i kallorna, skriv det inte\n- Rubriken ska vara specifik och nyhetsdriven, inte generell\n- Ingressen svarar pa: vad hande, vem ar inblandad, varfor spelar det roll\n- Varje stycke i brodtexten tillfor ny information\n- Citatpersonen ska vara specifik (namn + titel)\n\nSvara ENDAST med JSON utan kommentarer:\n{\n  "title": "Specifik nyhetrubrik max 12 ord",\n  "ingress": "2-3 meningar. Konkret, informativ, lockar till lasning.",\n  "body": "Stycke 1: Vad hande konkret (3-4 meningar med fakta).\\n\\nStycke 2: Bakgrund och varfor det spelar roll (2-3 meningar).\\n\\nStycke 3: Vad hander harnat eller reaktioner (1-2 meningar).",\n  "quote": "Konkret citat kopplat till handelsen",\n  "quoteAttr": "Fornamn Efternamn, titel"\n}';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const d = await r.json();
  const text = stripJsonFences(d.content[0].text);
  return JSON.parse(text);
}


// ── Pipeline State ────────────────────────────────────────────
let signals = [];
let signalsByCategory = {};
let trends = [];
let trendsByCategory = {};
let suggestions = [];
let pipelineLog = [];
let isRunning = false;
let lastRun = null;

function log(msg) {
  const e = { time: new Date().toISOString(), msg };
  pipelineLog.unshift(e);
  pipelineLog = pipelineLog.slice(0, 50);
  console.log('[PIPELINE]', msg);
}

async function fetchAndCluster(categoryFilter) {
  const items = await fetchAllFeeds();
  log('Hämtade ' + items.length + ' artiklar');
  const clustered = clusterItems(items, categoryFilter);
  log('Identifierade ' + clustered.length + ' signaler' + (categoryFilter ? ' [' + categoryFilter + ']' : ''));
  return clustered;
}

async function runSignalPipeline(categoryFilter) {
  if (isRunning) return;
  isRunning = true;
  log('Hämtar RSS från ' + Object.keys(SOURCES).length + ' källor...');
  try {
    const clustered = await fetchAndCluster(categoryFilter);
    if (categoryFilter) {
      signalsByCategory[categoryFilter] = clustered;
    } else {
      signals = clustered;
      // Also reset all category caches so they refresh
      signalsByCategory = {};
    }
    cache.del('signals');
  } catch(e) { log('Fel (signaler): ' + e.message); }
  isRunning = false;
  lastRun = new Date().toISOString();
}

async function runTrendAnalysis(categoryFilter) {
  // Ensure we have signals for this category
  if (categoryFilter) {
    if (!signalsByCategory[categoryFilter] || !signalsByCategory[categoryFilter].length) {
      log('Hämtar signaler för [' + categoryFilter + ']...');
      // Temporarily bypass isRunning for category pipeline
      const items = await fetchAllFeeds();
      signalsByCategory[categoryFilter] = clusterItems(items, categoryFilter);
      log('Identifierade ' + signalsByCategory[categoryFilter].length + ' signaler [' + categoryFilter + ']');
    }
  } else {
    if (!signals.length) await runSignalPipeline();
  }

  const sigPool = categoryFilter ? (signalsByCategory[categoryFilter] || []) : signals;

  if (!sigPool.length) {
    log('Inga signaler för ' + (categoryFilter || 'generellt') + ' — kör Uppdatera först');
    return;
  }

  const catLabel = categoryFilter ? ' [' + categoryFilter + ']' : '';
  log('Analyserar ' + sigPool.length + ' signaler med Claude' + catLabel + '...');

  try {
    const result = await analyzeSignals(sigPool, categoryFilter);
    const newTrends = await Promise.all(result.trends.map(async (t, i) => {
      // Match signal from the correct pool using signalId first, then index
      let signal = sigPool.find(s => s.id === t.signalId);
      if (!signal && typeof t.signalIndex === 'number') signal = sigPool[t.signalIndex];
      if (!signal) signal = sigPool[Math.min(i, sigPool.length - 1)];

      const imageQuery = t.imageQuery || t.headline || t.category || 'news';
      const image = await fetchUnsplashImage(imageQuery);
      log('Trend: ' + t.headline.slice(0, 40) + ' | bild: ' + (image ? 'OK' : 'saknas'));

      return {
        id: 'trend-' + Date.now() + '-' + i,
        headline: t.headline,
        angle: t.angle,
        category: t.category,
        image,
        signal,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
    }));

    if (categoryFilter) {
      trendsByCategory[categoryFilter] = newTrends;
    } else {
      trends = newTrends;
    }
    log('Klar: ' + newTrends.length + ' trender' + catLabel);
  } catch(e) {
    log('Fel (trender): ' + e.message);
    console.error(e);
  }
}

function findTrendById(id) {
  let t = trends.find(x => x.id === id);
  if (!t) {
    for (const cat of Object.keys(trendsByCategory)) {
      t = trendsByCategory[cat].find(x => x.id === id);
      if (t) break;
    }
  }
  return t;
}

// ── Routes ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', sources: Object.keys(SOURCES).length }));

app.get('/api/signals', async (req, res) => {
  const cat = req.query.category || '';
  if (cat) {
    if (!signalsByCategory[cat]) await runSignalPipeline(cat);
    return res.json(signalsByCategory[cat] || []);
  }
  if (!signals.length) await runSignalPipeline();
  res.json(signals);
});

app.get('/api/trends', (req, res) => {
  const category = req.query.category || '';
  if (category) return res.json(trendsByCategory[category] || []);
  res.json(trends);
});

app.post('/api/pipeline/signals', async (req, res) => {
  const cat = req.query.category || '';
  res.json({ ok: true });
  runSignalPipeline(cat);
});

app.post('/api/pipeline/trends', async (req, res) => {
  const category = req.query.category || '';
  res.json({ ok: true });
  runTrendAnalysis(category);
});

app.post('/api/trends/:id/draft', async (req, res) => {
  const trend = findTrendById(req.params.id);
  if (!trend) return res.status(404).json({ error: 'Trend not found' });
  try {
    log('Genererar artikelutkast för: ' + trend.headline);
    const draft = await generateDraft(trend.signal, trend);
    trend.draft = draft;
    trend.status = 'drafted';
    res.json(draft);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trends/:id/publish', async (req, res) => {
  const trend = findTrendById(req.params.id);
  if (!trend || !trend.draft) return res.status(400).json({ error: 'No draft' });
  const id = 'art-' + Date.now();
  const rawQuote = (trend.draft.quote || '').trim();
  const badQ = !rawQuote || rawQuote.length < 10 || /tyvärr|kan inte|saknas|information/i.test(rawQuote);
  const art = {
    id,
    title: trend.draft.title || trend.headline,
    ingress: trend.draft.ingress || '',
    body: trend.draft.body || '',
    quote: badQ ? '' : rawQuote,
    quoteAttr: badQ ? '' : (trend.draft.quoteAttr || ''),
    cat: trend.category,
    type: 'ai',
    image: trend.image || '',
    sources: (trend.signal?.items || []).slice(0, 5),
    pubDate: new Date().toISOString(),
    aiGenerated: true,
    featured: false,
  };
  saveArticle(art);
  trend.status = 'published';
  log('Publicerade: ' + art.title);
  res.json(art);
});

app.post('/api/trends/:id/dismiss', (req, res) => {
  const trend = findTrendById(req.params.id);
  if (trend) trend.status = 'dismissed';
  res.json({ ok: true });
});

app.get('/api/articles', (req, res) => res.json(readArticles().slice(0, 100)));

app.post('/api/articles', (req, res) => {
  const a = req.body;
  const id = a.id || 'art-' + Date.now();
  const art = { ...a, id, pubDate: a.pubDate || new Date().toISOString() };
  saveArticle(art);
  res.json(art);
});

app.patch('/api/articles/:id', (req, res) => {
  const allowed = ['title','ingress','body','cat','type','featured','image'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updateArticle(req.params.id, updates);
  res.json({ ok: true });
});

app.post('/api/articles/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'invalid' });
  const arts = readArticles();
  const posMap = {};
  order.forEach(o => { posMap[o.id] = o.position; });
  arts.sort((a, b) => (posMap[a.id] ?? 999) - (posMap[b.id] ?? 999));
  writeArticles(arts);
  res.json({ ok: true });
});

app.get('/api/pipeline/status', (req, res) => {
  const allTrends = trends.concat(Object.values(trendsByCategory).flat());
  res.json({
    lastRun,
    running: isRunning,
    signals: signals.length,
    trends: allTrends.length,
    pending: allTrends.filter(t => t.status === 'pending').length,
    log: pipelineLog.slice(0, 20),
  });
});

app.get('/api/feed', async (req, res) => {
  const cached = cache.get('feed');
  if (cached) return res.json(cached);
  const items = await fetchAllFeeds();
  cache.set('feed', items, 180);
  res.json(items);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('GRID backend på port ' + PORT));
