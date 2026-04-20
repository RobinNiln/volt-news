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

  // Send top 60 recent headlines to Claude
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const recent = items
    .filter(i => new Date(i.pubDate) > cutoff)
    .slice(0, 60);

  const lines = recent.map(i => i.sourceCode + ': ' + i.title).join('\n');

  const prompt = 'Du ar redaktionschef pa GRID, en svensk nyhetssajt. Nedan ar de senaste rubrikerna fran svenska medier.\n\n' + lines + '\n\nIdentifiera de 5 viktigaste VERKLIGA nyhetsamnesena just nu. STRIKTA REGLER:\n1. ALDRIG generella ord som amne — varje trend maste vara en specifik nyhandelse\n2. Gruppera relaterade artiklar till ETT amne (Iran+USA+fartyg = ett amne)\n3. Skriv rubriken som en konkret mening: VAD hander, VEM, VAR\n4. Lagg till explanation: 2 meningar som forklarar handelsen och varfor den ar viktig\n5. Ignorera debatt och opinion\n\nBra rubrik: "Trump beordrar militarangrepp mot iranskt fartyg"\nDalig rubrik: "amerikanska" eller "skriver" eller "kronor"\n\nSvara ENDAST med JSON: {"trends": [{"headline": "...", "explanation": "...", "category": "...", "sources": ["AB","EX"], "articleCount": 5}]}';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  const text = d.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g, '').trim();
  const parsed = JSON.parse(text);

  const sourceMap = {};
  Object.entries(SOURCES).forEach(([, s]) => { sourceMap[s.code] = s; });

  return parsed.trends.map(t => ({
    keyword: t.headline,
    headline: t.headline,
    explanation: t.explanation || '',
    category: t.category || '',
    articleCount: t.articleCount || 0,
    sourceCount: t.sources.length,
    sources: t.sources.map(code => sourceMap[code] || { name: code, code, color: '#555' }),
    totalArticles: recent.length,
    headlines: recent
      .filter(i => t.sources.includes(i.sourceCode))
      .slice(0, 3)
      .map(i => ({ title: i.title, source: i.source }))
  }));
}

async function generateSuggestions(groups) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY saknas');

  const groupSummaries = groups.slice(0, 8).map((g, i) => {
    const titles = g.items.map(item => item.source + ': "' + item.title + '"').join('\n');
    return (i + 1) + '. AMNE: ' + g.keyword + ' (' + g.items.length + ' kallor)\n' + titles;
  }).join('\n\n');

  const prompt = 'Du ar journalist pa GRID, en svensk nyhetssajt. Baserat pa foljande artiklar fran svenska medier, skriv ett artikelforslag.\n\nKALLOR:\n' + sourceList + '\n\nSkriv ett riktigt artikelforslag med rubrik och ingress. Svara ENDAST med JSON:\n{"title": "Rubrik (max 12 ord, konkret och tydlig)", "category": "En av: Politik/Ekonomi/Samhalle/Industri/Klimat/Sport/Naringsliv/Kultur", "ingress": "2-3 meningar som satter scenen, berättar vad som hant och varfor det ar viktigt", "body": ["Stycke 1 (3-4 meningar)", "Stycke 2 (2-3 meningar)"], "quote": "Fiktivt men trovärdigt citat", "quoteAttr": "Namn, titel"}';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error('API fel: ' + response.status);
  const data = await response.json();
  const text = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(text);

  return parsed.suggestions.map((s, i) => {
    const group = groups[i] || groups[0];
    return {
      id: 'sug-' + Date.now() + '-' + i,
      title: s.title,
      ingress: s.ingress,
      category: s.category,
      keyword: s.keyword || group.keyword,
      sourceCount: group.items.length,
      sources: group.items.slice(0, 5).map(item => ({
        name: item.source,
        code: item.sourceCode,
        color: item.sourceColor,
        title: item.title,
        link: item.link
      })),
      createdAt: new Date().toISOString(),
      status: 'pending'
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
  const article = { id, title: s.title, ingress: s.ingress, cat: s.category, body: '', quote: '', quoteAttr: '', sources: s.sources, pubDate, type: 'ai', aiGenerated: true };
  insertArticle.run(id, s.title, s.ingress, '', s.category, 'ai', '', '', JSON.stringify(s.sources), pubDate, 1);
  res.json(article);
});

app.post('/api/suggestions/:id/dismiss', (req, res) => {
  const s = suggestions.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.status = 'dismissed';
  res.json({ ok: true });
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
