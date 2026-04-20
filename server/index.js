const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const parser = new Parser({ timeout: 10000 });
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json());

// SQLite
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'grid.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY, title TEXT, ingress TEXT, body TEXT,
    cat TEXT, type TEXT DEFAULT 'journalist', quote TEXT, quote_attr TEXT,
    sources TEXT, pub_date TEXT, ai_generated INTEGER DEFAULT 0
  );
`);
const insertArticle = db.prepare(`INSERT OR REPLACE INTO articles
  (id,title,ingress,body,cat,type,quote,quote_attr,sources,pub_date,ai_generated)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const updateArticle = db.prepare(`UPDATE articles SET title=?,ingress=?,body=?,cat=?,type=? WHERE id=?`);

const SOURCES = {
  aftonbladet: { name:'Aftonbladet', code:'AB',  color:'#e8001a', url:'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/' },
  expressen:   { name:'Expressen',   code:'EX',  color:'#006AA7', url:'https://feeds.expressen.se/nyheter/' },
  dn:          { name:'DN',          code:'DN',  color:'#1a1a1a', url:'https://www.dn.se/rss/' },
  svd:         { name:'SvD',         code:'SvD', color:'#002E6E', url:'https://www.svd.se/feed/articles.rss' },
  sydsvenskan: { name:'Sydsvenskan', code:'SDS', color:'#D92B3A', url:'https://www.sydsvenskan.se/rss.xml' },
  barometern:  { name:'Barometern',  code:'BAR', color:'#2B6E3A', url:'https://www.barometern.se/rss/' },
  svt:         { name:'SVT Nyheter', code:'SVT', color:'#1A5276', url:'https://www.svt.se/nyheter/rss.xml' },
  norran:      { name:'Norran',      code:'NOR', color:'#555',    url:'https://www.norran.se/rss/' },
  nsd:         { name:'NSD',         code:'NSD', color:'#555',    url:'https://www.nsd.se/rss/' },
  unt:         { name:'UNT',         code:'UNT', color:'#555',    url:'https://www.unt.se/rss/' },
  nt:          { name:'NT',          code:'NT',  color:'#555',    url:'https://www.nt.se/rss/' },
  corren:      { name:'Corren',      code:'COR', color:'#555',    url:'https://www.corren.se/rss/' },
  helagotland: { name:'Hela Gotland',code:'HG',  color:'#555',    url:'https://www.helagotland.se/rss/' },
};

let suggestions = [];
let pipelineLog = [];
let pipelineEnabled = true;
let isRunning = false;
let lastRun = null;

function log(msg) {
  const e = { time: new Date().toISOString(), msg };
  pipelineLog.unshift(e);
  pipelineLog = pipelineLog.slice(0, 50);
  console.log('[PIPELINE] ' + msg);
}

async function fetchFeed(key, source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 20).map(item => ({
      id: item.guid || item.link,
      title: item.title || '',
      description: item.contentSnippet || item.summary || '',
      link: item.link,
      pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
      source: source.name,
      sourceCode: source.code,
      sourceColor: source.color,
    }));
  } catch(e) {
    console.error('Failed ' + key + ':', e.message);
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

// ─── CORE AI FUNCTION ────────────────────────────────────────
// Sends headlines to Claude, gets back trends + full article drafts in one call
async function runAIPipeline(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY saknas');

  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  const recent = items
    .filter(i => new Date(i.pubDate) > cutoff)
    .slice(0, 80);

  if (recent.length < 5) throw new Error('For fa artiklar: ' + recent.length);

  const headlines = recent.map(i => i.sourceCode + ': ' + i.title).join('\n');

  const prompt = `Du ar chefsredaktor pa GRID, en svensk nyhetssajt. Nedan ar ${recent.length} rubriker fran svenska nyhetsmedier de senaste 8 timmarna.

${headlines}

GOR FOLJANDE:

1. Identifiera de 5 mest bevakvarda UNIKA nyhetsamnesena. Varje amne maste vara en specifik verklig handelse. FORBJUDNA amnen: generella ord som "sverige", "skriver", "kommer", "svenska", "manden", "dagen" etc. Gruppera relaterade nyheter (tex Iran+USA+militart = ETT amne).

2. For varje amne, skriv ett komplett artikelutkast som GRID kan publicera.

Svara MED EXAKT DETTA JSON-format och ingenting annat:
{
  "trends": [
    {
      "headline": "Konkret rubrik max 10 ord som beskriver specifik handelse",
      "explanation": "Mening 1 om vad som hander. Mening 2 om varfor det ar viktigt.",
      "category": "En av: Politik / Ekonomi / Samhalle / Industri / Klimat / Sport / Naringsliv / Kultur",
      "sources": ["AB", "EX"],
      "articleCount": 7,
      "article": {
        "title": "Fullstandig rubrik for artikeln max 12 ord",
        "ingress": "2-3 meningar som satter scenen och lockar lasaren. Ska svara pa vad hande vem ar inblandad och varfor det spelar roll.",
        "body": "Forsta stycket med 3-4 meningar om vad som faktiskt hant baserat pa rubrikerna. Andra stycket med 2-3 meningar om bakgrund eller kontext. Tredje stycket med 1-2 meningar om vad som vantas handa.",
        "quote": "Ett trovärdigt citat fran en relevant person",
        "quoteAttr": "Namn Titel"
      }
    }
  ]
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
  });

  if (!r.ok) throw new Error('Anthropic API ' + r.status);
  const d = await r.json();
  const text = d.content[0].text.trim().replace(/```json\n?|```\n?/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch(e) {
    throw new Error('JSON parse failed: ' + text.slice(0, 200));
  }

  const sourceMap = {};
  Object.entries(SOURCES).forEach(([, s]) => { sourceMap[s.code] = s; });

  return parsed.trends.map((t, i) => {
    const matchedItems = recent.filter(item => (t.sources || []).includes(item.sourceCode));
    return {
      id: 'sug-' + Date.now() + '-' + i,
      keyword: t.headline,
      headline: t.headline,
      explanation: t.explanation || '',
      category: t.category || 'Nyheter',
      articleCount: t.articleCount || matchedItems.length,
      sourceCount: (t.sources || []).length,
      sources: (t.sources || []).map(code => sourceMap[code] || { name: code, code, color: '#555' }),
      totalArticles: recent.length,
      article: {
        title: (t.article && t.article.title) || t.headline,
        ingress: (t.article && t.article.ingress) || '',
        body: (t.article && t.article.body) || '',
        quote: (t.article && t.article.quote) || '',
        quoteAttr: (t.article && t.article.quoteAttr) || '',
        category: t.category || 'Nyheter',
      },
      sourceItems: matchedItems.slice(0, 5).map(item => ({
        name: item.source, code: item.sourceCode, color: item.sourceColor,
        title: item.title, link: item.link
      })),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  });
}

async function runPipeline() {
  if (!pipelineEnabled || isRunning) return;
  isRunning = true;
  log('Pipeline startar...');
  try {
    const items = await fetchAllFeeds();
    log('Hamtade ' + items.length + ' artiklar fran ' + Object.keys(SOURCES).length + ' kallor');
    log('Skickar till Claude for trendanalys och artikelutkast...');
    const results = await runAIPipeline(items);
    suggestions = results;
    cache.del('trends');
    log('Klar: ' + results.length + ' trender och artikelutkast genererade');
  } catch(e) {
    log('Fel: ' + e.message);
  }
  lastRun = new Date().toISOString();
  isRunning = false;
}

// ─── ROUTES ──────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', sources: Object.keys(SOURCES).length }));

app.get('/api/sources', (req, res) => {
  res.json(Object.entries(SOURCES).map(([key, s]) => ({ key, name: s.name, code: s.code, color: s.color })));
});

app.get('/api/feed', async (req, res) => {
  const cached = cache.get('feed');
  if (cached) return res.json(cached);
  const items = await fetchAllFeeds();
  cache.set('feed', items);
  res.json(items);
});

app.get('/api/trends', async (req, res) => {
  // Return cached pipeline results as trends
  const pending = suggestions.filter(s => s.status === 'pending');
  if (pending.length) {
    return res.json(pending.map(s => ({
      keyword: s.keyword,
      headline: s.headline,
      explanation: s.explanation,
      category: s.category,
      articleCount: s.articleCount,
      sourceCount: s.sourceCount,
      sources: s.sources,
      totalArticles: s.totalArticles,
    })));
  }
  // No cached results — run a lightweight trend fetch
  try {
    const cached = cache.get('trends');
    if (cached) return res.json(cached);
    const items = await fetchAllFeeds();
    const results = await runAIPipeline(items);
    // Store as suggestions so they can be published
    suggestions = results;
    const trends = results.map(s => ({
      keyword: s.keyword, headline: s.headline, explanation: s.explanation,
      category: s.category, articleCount: s.articleCount,
      sourceCount: s.sourceCount, sources: s.sources, totalArticles: s.totalArticles,
    }));
    cache.set('trends', trends, 900);
    res.json(trends);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/suggestions', (req, res) => res.json(suggestions));

app.post('/api/suggestions/:id/publish', (req, res) => {
  const s = suggestions.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.status = 'published';
  const id = 'art-' + Date.now();
  const pubDate = new Date().toISOString();
  const art = s.article || {};
  const srcs = s.sourceItems || s.sources || [];
  insertArticle.run(id, art.title||'', art.ingress||'', art.body||'', art.category||'Nyheter', 'ai', art.quote||'', art.quoteAttr||'', JSON.stringify(srcs), pubDate, 1);
  res.json({ id, title: art.title, ingress: art.ingress, body: art.body, cat: art.category, quote: art.quote, quoteAttr: art.quoteAttr, sources: srcs, pubDate, type: 'ai', aiGenerated: true });
});

app.post('/api/suggestions/:id/dismiss', (req, res) => {
  const s = suggestions.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.status = 'dismissed';
  res.json({ ok: true });
});

app.get('/api/articles', (req, res) => {
  const rows = db.prepare('SELECT * FROM articles ORDER BY pub_date DESC LIMIT 100').all();
  res.json(rows.map(r => ({ ...r, pubDate: r.pub_date, quoteAttr: r.quote_attr, aiGenerated: !!r.ai_generated, sources: r.sources ? JSON.parse(r.sources) : [] })));
});

app.post('/api/articles', (req, res) => {
  const a = req.body;
  const id = a.id || 'art-' + Date.now();
  const pubDate = new Date().toISOString();
  insertArticle.run(id, a.title||'', a.ingress||'', a.body||'', a.cat||'Nyheter', a.type||'journalist', a.quote||'', a.quoteAttr||'', JSON.stringify(a.sources||[]), pubDate, a.aiGenerated ? 1 : 0);
  res.json({ id, ...a, pubDate });
});

app.patch('/api/articles/:id', (req, res) => {
  const { title, ingress, body, cat, type } = req.body;
  try {
    updateArticle.run(title||'', ingress||'', body||'', cat||'', type||'journalist', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pipeline/status', (req, res) => {
  res.json({ enabled: pipelineEnabled, lastRun, running: isRunning, suggestions: suggestions.filter(s => s.status === 'pending').length, log: pipelineLog.slice(0, 20) });
});

app.post('/api/pipeline/toggle', (req, res) => {
  pipelineEnabled = !pipelineEnabled;
  log(pipelineEnabled ? 'Aktiverad' : 'Pausad');
  res.json({ enabled: pipelineEnabled });
});

app.post('/api/pipeline/run', (req, res) => {
  res.json({ ok: true });
  runPipeline();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('GRID backend pa port ' + PORT));
