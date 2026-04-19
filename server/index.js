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
  gp:          { name: 'GP',           code: 'GP',  color: '#005B99', url: 'https://www.gp.se/feed/articles.rss' },
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
  const stopwords = new Set(['också','eller','sedan','skulle','vilken','vilket','vilka','dessa','deras','hans','hennes','vara','varit','detta','något','några','varje','olika','många','andra','även','under','efter','bland','ingen','inget','inga','mellan','genom','kring','utan','varför','fastän','medan','tills','ändå','annars','troligen','antagligen','förmodligen','möjligen','kanske','knappt','nästan','ungefär','åtminstone','minst','mest','väldigt','mycket','lite','ganska','och','att','det','som','en','ett','på','av','för','med','är','har','den','de','inte','till','om','men','vi','kan','sig','var','han','hon','alla','när','bli','ska','sin','från','efter','hade','även','under','ut','in','upp','ner','nu','här','där','då','vad','vem','hur','just','bara','redan','ännu','igen','alltid','aldrig','ofta','ibland','fort','hem','bort','dit','hit','upp','ned','fram','bak','fel','nya','nya','nya','säger','enligt','uppger','bekräftar','meddelar','rapporterar','skriver','berättar']);

  const groups = {};
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  items.filter(i => new Date(i.pubDate) > cutoff).forEach(item => {
    const words = (item.title + ' ' + item.description)
      .toLowerCase()
      .replace(/[^a-zåäö\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 5 && !stopwords.has(w));
    const unique = [...new Set(words)];
    unique.forEach(word => {
      if (!groups[word]) groups[word] = [];
      if (!groups[word].find(i => i.id === item.id)) groups[word].push(item);
    });
  });

  // Score and sort groups
  const scored = Object.entries(groups)
    .filter(([, items]) => {
      const sources = new Set(items.map(i => i.source));
      return items.length >= 3 && sources.size >= 2;
    })
    .map(([keyword, items]) => ({
      keyword,
      items: items.slice(0, 8),
      score: items.length * new Set(items.map(i => i.source)).size
    }))
    .sort((a, b) => b.score - a.score);

  // Deduplicate — remove groups that share >50% articles with a higher-ranked group
  const selected = [];
  const usedIds = new Set();

  for (const group of scored) {
    const ids = new Set(group.items.map(i => i.id));
    const overlap = [...ids].filter(id => usedIds.has(id)).length;
    const overlapRatio = overlap / ids.size;
    if (overlapRatio < 0.5) {
      selected.push(group);
      ids.forEach(id => usedIds.add(id));
    }
    if (selected.length >= 10) break;
  }

  return selected;
}

async function generateSuggestions(groups) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY saknas');

  const groupSummaries = groups.slice(0, 8).map((g, i) => {
    const titles = g.items.map(item => item.source + ': "' + item.title + '"').join('\n');
    return (i + 1) + '. AMNE: ' + g.keyword + ' (' + g.items.length + ' kallor)\n' + titles;
  }).join('\n\n');

  const prompt = `Du ar journalist pa GRID, en svensk nationell nyhetssajt som bevakar Sverige lokalt och nationellt.

Nedan ar 8 amnesgrupper baserade pa vad svenska medier skriver om just nu. Varje grupp representerar ett potentiellt nationellt nyhetsamnne.

${groupSummaries}

Skriv 8 SEPARATA artikelforslag — ett per amnesgrupp. Varje forslag ska innehalla:
- En stark rubrik (max 12 ord)
- En ingress pa 2-3 meningar som satter scenen och lockar lasaren
- Kategorin (Politik/Ekonomi/Samhalle/Industri/Klimat/Sport/Naringsliv/Kultur)

Svara ENDAST med giltig JSON, ingen annan text:
{
  "suggestions": [
    {
      "title": "...",
      "ingress": "...",
      "category": "...",
      "keyword": "...",
      "sourceCount": 0,
      "sources": [{"name": "...", "code": "...", "color": "..."}]
    }
  ]
}`;

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

    const groups = groupByTopic(items);
    log('Hittade ' + groups.length + ' trender');

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


// GET /api/trends — top 5 trends with AI-generated titles
app.get('/api/trends', async (req, res) => {
  try {
    const cached = cache.get('trends');
    if (cached) return res.json(cached);

    const items = await fetchAllFeeds();
    const groups = groupByTopic(items);
    if (!groups.length) return res.json([]);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    let trends;

    if (apiKey) {
      // Generate readable trend titles via Claude
      const summaries = groups.slice(0, 5).map((g, i) =>
        (i+1) + '. Nyckelord: ' + g.keyword + '\n' +
        g.items.slice(0,4).map(a => '- ' + a.source + ': "' + a.title + '"').join('\n')
      ).join('\n\n');

      const prompt = 'Du ar redaktionschef pa GRID, en svensk nyhetssajt. Nedan ar 5 amnesgrupper som svenska medier skriver om just nu.\n\n' + summaries + '\n\nSkriv en kort, tydlig redaktionell rubrik for varje trend (max 8 ord). Rubriken ska ge redaktoren en snabb bild av vad som hander — konkret, inte generell.\n\nSvara ENDAST med giltig JSON:\n{"trends": [{"keyword": "...", "headline": "..."}]}';

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await response.json();
      const parsed = JSON.parse(data.content[0].text.trim().replace(/```json|```/g, '').trim());
      const headlines = {};
      parsed.trends.forEach(t => { headlines[t.keyword] = t.headline; });

      trends = groups.slice(0, 5).map(g => {
        const sources = [...new Map(g.items.map(i => [i.source, {name:i.source, code:i.sourceCode, color:i.sourceColor}])).values()];
        return {
          keyword: g.keyword,
          headline: headlines[g.keyword] || g.keyword,
          articleCount: g.items.length,
          sourceCount: new Set(g.items.map(i => i.source)).size,
          sources: sources.slice(0, 6),
          totalArticles: items.length,
          headlines: g.items.slice(0, 3).map(i => ({ title: i.title, source: i.source }))
        };
      });
    } else {
      trends = groups.slice(0, 5).map(g => {
        const sources = [...new Map(g.items.map(i => [i.source, {name:i.source, code:i.sourceCode, color:i.sourceColor}])).values()];
        return { keyword: g.keyword, headline: g.keyword, articleCount: g.items.length, sourceCount: new Set(g.items.map(i => i.source)).size, sources: sources.slice(0, 6), totalArticles: items.length, headlines: g.items.slice(0, 3).map(i => ({ title: i.title, source: i.source })) };
      });
    }

    cache.set('trends', trends, 900);
    res.json(trends);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('GRID backend pa port ' + PORT));
