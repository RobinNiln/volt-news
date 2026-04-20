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

// SQLite setup — persistent storage on Railway Volume
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'grid.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    ingress TEXT,
    body TEXT,
    cat TEXT,
    type TEXT DEFAULT 'journalist',
    quote TEXT,
    quote_attr TEXT,
    sources TEXT,
    pub_date TEXT,
    ai_generated INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    keyword TEXT,
    article TEXT,
    sources TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT
  );
`);

const insertArticle = db.prepare(`INSERT OR REPLACE INTO articles (id, title, ingress, body, cat, type, quote, quote_attr, sources, pub_date, ai_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertSuggestion = db.prepare(`INSERT OR REPLACE INTO suggestions (id, keyword, article, sources, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const updateSuggestionStatus = db.prepare(`UPDATE suggestions SET status = ? WHERE id = ?`);

const SOURCES = {
  aftonbladet: { name: 'Aftonbladet',  code: 'AB',  color: '#e8001a', url: 'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/' },
  expressen:   { name: 'Expressen',    code: 'EX',  color: '#006AA7', url: 'https://feeds.expressen.se/nyheter/' },
  dn:          { name: 'DN',           code: 'DN',  color: '#1a1a1a', url: 'https://www.dn.se/rss/' },
  svd:         { name: 'SvD',          code: 'SvD', color: '#002E6E', url: 'https://www.svd.se/feed/articles.rss' },
  sydsvenskan: { name: 'Sydsvenskan',  code: 'SDS', color: '#D92B3A', url: 'https://www.sydsvenskan.se/rss.xml' },
  svt:         { name: 'SVT Nyheter',  code: 'SVT', color: '#1A5276', url: 'https://www.svt.se/nyheter/rss.xml' },
  barometern:  { name: 'Barometern',   code: 'BAR', color: '#2B6E3A', url: 'https://www.barometern.se/rss/' },
  norran:      { name: 'Norran',       code: 'NOR', color: '#666', url: 'https://www.norran.se/rss/' },
  nsd:         { name: 'NSD',          code: 'NSD', color: '#666', url: 'https://www.nsd.se/rss/' },
  unt:         { name: 'UNT',          code: 'UNT', color: '#666', url: 'https://www.unt.se/rss/' },
  nt:          { name: 'NT',           code: 'NT',  color: '#666', url: 'https://www.nt.se/rss/' },
  corren:      { name: 'Corren',       code: 'COR', color: '#666', url: 'https://www.corren.se/rss/' },
  helagotland: { name: 'Hela Gotland', code: 'HG',  color: '#666', url: 'https://www.helagotland.se/rss/' },
};

let suggestions = [];
let pipelineLog = [];
let pipelineEnabled = true;
let lastRun = null;
let isRunning = false;

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
      type: 'external'
    }));
  } catch(e) {
    console.error(`Failed ${key}:`, e.message);
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

function groupByTopic(items) {
  // Not used when Claude identifies trends — kept as fallback
  return [];
}

async function identifyTrendsWithClaude(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const recent = items
    .filter(i => new Date(i.pubDate) > cutoff)
    .slice(0, 80);

  if (!recent.length) return null;

  const lines = recent.map(i => i.sourceCode + ': ' + i.title).join('\n');

  const prompt = `Du ar redaktionschef pa en svensk nyhetssajt. Nedan ar ${recent.length} rubriker fran svenska nyhetsmedier de senaste 6 timmarna.

${lines}

Identifiera de 5 viktigaste UNIKA nyhetsamnesena. Regler:
- Varje amne ska vara en specifik verklig handelseinte ett generellt ord
- Gruppera ALLA relaterade rubriker till ETT amne (tex alla om Iran/USA = ett amne)
- Skriv headline som en konkret nyhetsmening (max 10 ord): vad hander vem var
- Skriv explanation: 2 korta meningar om vad som pagar och varfor det ar viktigt
- Ignorera opinion debatt och kronikaartiklar

Svara ENDAST med detta JSON-format:
{"trends": [{"headline": "konkret rubrik", "explanation": "Mening 1. Mening 2.", "category": "Politik", "sources": ["AB", "EX"], "articleCount": 7}]}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });

  if (!r.ok) throw new Error('API ' + r.status);
  const d = await r.json();
  const text = d.content[0].text.trim().replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(text);

  const sourceMap = {};
  Object.entries(SOURCES).forEach(([, s]) => { sourceMap[s.code] = s; });

  return parsed.trends.map(t => ({
    keyword: t.headline,
    headline: t.headline,
    explanation: t.explanation || '',
    category: t.category || '',
    articleCount: t.articleCount || 0,
    sourceCount: (t.sources || []).length,
    sources: (t.sources || []).map(code => sourceMap[code] || { name: code, code, color: '#555' }),
    totalArticles: recent.length,
    headlines: recent
      .filter(i => (t.sources || []).includes(i.sourceCode))
      .slice(0, 3)
      .map(i => ({ title: i.title, source: i.source }))
  }));
}

async function generateSuggestions(groups) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY saknas');

  // Generate one suggestion per group, in parallel batches of 4
  const results = [];
  for (let i = 0; i < Math.min(groups.length, 8); i++) {
    const g = groups[i];
    const titles = g.items.slice(0, 6).map(item => '- ' + item.source + ': "' + item.title + '"').join('\n');

    const prompt = `Du ar journalist pa GRID, en svensk nyhetssajt. Foljande svenska medier rapporterar om samma amne:

${titles}

Skriv ett artikelforslag baserat pa dessa kallor. Svara ENDAST med JSON:
{
  "title": "Konkret rubrik max 12 ord",
  "category": "En av: Politik Ekonomi Samhalle Industri Klimat Sport Naringsliv Kultur",
  "ingress": "2-3 meningar som berättar vad som hant varfor det ar viktigt och vad som kan handa harehef",
  "body": ["Forsta stycket 3-4 meningar med mer detaljer", "Andra stycket 2-3 meningar med kontext eller bakgrund"]
}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
      });
      if (!r.ok) { log('Suggestion API error: ' + r.status); continue; }
      const d = await r.json();
      const text = d.content[0].text.trim().replace(/```json|```/g, '').trim();
      const art = JSON.parse(text);

      results.push({
        id: 'sug-' + Date.now() + '-' + i,
        article: {
          title: art.title || '',
          ingress: art.ingress || '',
          category: art.category || 'Nyheter',
          body: Array.isArray(art.body) ? art.body.join('\n\n') : (art.body || '')
        },
        keyword: g.keyword,
        sourceCount: g.items.length,
        sources: g.items.slice(0, 5).map(item => ({
          name: item.source,
          code: item.sourceCode,
          color: item.sourceColor,
          title: item.title,
          link: item.link
        })),
        createdAt: new Date().toISOString(),
        status: 'pending'
      });
    } catch(e) {
      log('Suggestion ' + i + ' failed: ' + e.message);
    }
  }
  return results;
}

async function runPipeline() {
  if (!pipelineEnabled || isRunning) return;
  isRunning = true;
  log('Pipeline startar...');
  try {
    const items = await fetchAllFeeds();
    log('Hamtade ' + items.length + ' artiklar fran ' + Object.keys(SOURCES).length + ' kallor');

    // Use Claude to identify trends first
    let groups = [];
    try {
      const trends = await identifyTrendsWithClaude(items);
      if (trends && trends.length) {
        // Convert trends to groups format
        groups = trends.map(t => ({
          keyword: t.headline,
          items: t.headlines.map(h => ({
            id: h.title,
            title: h.title,
            description: '',
            source: h.source,
            sourceCode: (Object.values(SOURCES).find(s => s.name === h.source) || {}).code || '',
            sourceColor: (Object.values(SOURCES).find(s => s.name === h.source) || {}).color || '#555',
            link: '',
            pubDate: new Date().toISOString()
          }))
        }));
        log('Identifierade ' + groups.length + ' trender via Claude');
      }
    } catch(e) {
      log('Trend-identifiering misslyckades: ' + e.message);
    }

    if (!groups.length) { log('Inga trender denna korning'); isRunning = false; return; }

    log('Genererar ' + Math.min(groups.length, 8) + ' forslag via Claude...');
    const newSuggestions = await generateSuggestions(groups);
    suggestions = newSuggestions;
    cache.del('feed');
    log('Klar — ' + newSuggestions.length + ' forslag genererade');
  } catch(e) {
    log('Fel: ' + e.message);
  }
  lastRun = new Date().toISOString();
  isRunning = false;
}

function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  pipelineLog.unshift(entry);
  pipelineLog = pipelineLog.slice(0, 50);
  console.log('[PIPELINE] ' + msg);
}

// Pipeline runs only on manual trigger via /api/pipeline/run

// Routes
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

app.get('/api/suggestions', (req, res) => res.json(suggestions));

app.post('/api/suggestions/refresh', async (req, res) => {
  res.json({ ok: true });
  runPipeline();
});

app.post('/api/suggestions/:id/publish', (req, res) => {
  const s = suggestions.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.status = 'published';
  updateSuggestionStatus.run('published', s.id);
  const id = 'art-' + Date.now();
  const pubDate = new Date().toISOString();
  const art = s.article || {};
  const title = art.title || s.title || '';
  const ingress = art.ingress || s.ingress || '';
  const cat = art.category || s.category || 'Nyheter';
  const body = art.body || '';
  const article = { id, title, ingress, cat, body, sources: s.sources, pubDate, type: 'ai', aiGenerated: true };
  insertArticle.run(id, title, ingress, body, cat, 'ai', '', '', JSON.stringify(s.sources), pubDate, 1);
  res.json(article);
});

app.post('/api/suggestions/:id/dismiss', (req, res) => {
  const s = suggestions.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.status = 'dismissed';
  res.json({ ok: true });
});


app.patch('/api/articles/:id', (req, res) => {
  try {
    const { title, ingress, body, cat, type } = req.body;
    db.prepare('UPDATE articles SET title=?, ingress=?, body=?, cat=?, type=? WHERE id=?')
      .run(title||'', ingress||'', body||'', cat||'', type||'journalist', req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/articles', (req, res) => {
  const rows = db.prepare('SELECT * FROM articles ORDER BY pub_date DESC LIMIT 100').all();
  res.json(rows.map(r => ({
    ...r,
    pubDate: r.pub_date,
    quoteAttr: r.quote_attr,
    aiGenerated: !!r.ai_generated,
    sources: r.sources ? JSON.parse(r.sources) : []
  })));
});

app.post('/api/articles', (req, res) => {
  const a = req.body;
  const id = a.id || 'art-' + Date.now();
  const pubDate = new Date().toISOString();
  insertArticle.run(id, a.title||'', a.ingress||'', a.body||'', a.cat||'Nyheter', a.type||'journalist', a.quote||'', a.quoteAttr||'', JSON.stringify(a.sources||[]), pubDate, a.aiGenerated ? 1 : 0);
  res.json({ id, ...a, pubDate });
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


// GET /api/trends — Claude identifies real trends from headlines
app.get('/api/trends', async (req, res) => {
  try {
    const cached = cache.get('trends');
    if (cached) return res.json(cached);

    const items = await fetchAllFeeds();
    if (!items.length) return res.json([]);

    // Try Claude-based trend identification
    let trends = null;
    try {
      trends = await identifyTrendsWithClaude(items);
    } catch(e) {
      log('Claude trend identification failed: ' + e.message);
    }

    // Fallback: simple word-frequency if Claude fails
    if (!trends) {
      trends = [{
        keyword: 'Kunde inte identifiera trender',
        headline: 'Kunde inte identifiera trender — prova igen',
        articleCount: 0, sourceCount: 0, sources: [], totalArticles: items.length, headlines: []
      }];
    }

    cache.set('trends', trends, 900);
    res.json(trends);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('GRID backend pa port ' + PORT));
