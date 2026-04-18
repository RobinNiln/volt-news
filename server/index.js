const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');

const app = express();
const parser = new Parser({ timeout: 10000 });
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json());

const SOURCES = {
  aftonbladet: { name: 'Aftonbladet', code: 'AB', color: '#e8001a', url: 'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/' },
  expressen:   { name: 'Expressen',   code: 'EX', color: '#006AA7', url: 'https://feeds.expressen.se/nyheter/' },
  dn:          { name: 'DN',          code: 'DN', color: '#1a1a1a', url: 'https://www.dn.se/rss/' },
  svd:         { name: 'SvD',         code: 'SvD', color: '#002E6E', url: 'https://www.svd.se/feed/articles.rss' },
  sydsvenskan: { name: 'Sydsvenskan', code: 'SDS', color: '#D92B3A', url: 'https://www.sydsvenskan.se/rss.xml' },
  gp:          { name: 'GP',          code: 'GP',  color: '#005B99', url: 'https://www.gp.se/feed/articles.rss' },
  barometern:  { name: 'Barometern',  code: 'BAR', color: '#2B6E3A', url: 'https://www.barometern.se/rss/' },
  norran:      { name: 'Norran',      code: 'NOR', color: '#555', url: 'https://www.norran.se/rss/' },
  nsd:         { name: 'NSD',         code: 'NSD', color: '#555', url: 'https://www.nsd.se/rss/' },
  unt:         { name: 'UNT',         code: 'UNT', color: '#555', url: 'https://www.unt.se/rss/' },
  nt:          { name: 'NT',          code: 'NT',  color: '#555', url: 'https://www.nt.se/rss/' },
  ostgota:     { name: 'Östgöta Correspondenten', code: 'ÖC', color: '#555', url: 'https://www.corren.se/rss/' },
};

// In-memory stores
const articles = [];
const drafts = [];
let pipelineLog = [];
let pipelineEnabled = true;
let lastRun = null;

// ─── RSS FETCH ───────────────────────────────────────────────
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

// ─── PATTERN DETECTION ───────────────────────────────────────
function groupByTopic(items) {
  const groups = {};
  const stopwords = new Set(['och','att','det','som','en','ett','på','av','för','med','är','har','den','de','inte','till','om','men','vi','kan','sig','var','han','hon','alla','när','bli','ska','sin','från','efter','hade','även','under','ut']);

  items.forEach(item => {
    const words = (item.title + ' ' + item.description)
      .toLowerCase()
      .replace(/[^a-zåäö\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !stopwords.has(w));

    words.forEach(word => {
      if (!groups[word]) groups[word] = [];
      if (!groups[word].find(i => i.id === item.id)) {
        groups[word].push(item);
      }
    });
  });

  // Keep only groups with 3+ articles from 2+ different sources
  return Object.entries(groups)
    .filter(([, items]) => {
      const sources = new Set(items.map(i => i.source));
      return items.length >= 3 && sources.size >= 2;
    })
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([keyword, items]) => ({ keyword, items: items.slice(0, 8) }));
}

// ─── AI ARTICLE GENERATION ───────────────────────────────────
async function generateArticle(group) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const sourceList = group.items.map(i =>
    `- ${i.source}: "${i.title}" ${i.description ? '— ' + i.description.slice(0, 100) : ''}`
  ).join('\n');

  const prompt = `Du är journalist på GRID, en svensk nationell nyhetssajt. Baserat på följande artiklar från svenska medier som alla handlar om samma ämne, skriv ett artikelutkast på svenska.

KÄLLOR:
${sourceList}

Skriv artikeln i följande JSON-format (svara ENDAST med JSON, inget annat):
{
  "title": "Rubrik (max 12 ord, pregnant och tydlig)",
  "category": "En av: Politik, Ekonomi, Samhälle, Industri, Klimat, Sport, Näringsliv, Kultur",
  "ingress": "2-3 meningar som sätter scenen och fångar läsaren",
  "body": ["Stycke 1 (3-4 meningar, berättande)", "Stycke 2 (3-4 meningar, fördjupning)", "Stycke 3 (2-3 meningar, kontext eller framåtblick)"],
  "quote": "Ett fiktivt men trovärdigt citat från en relevant källa",
  "quoteAttr": "Namn, titel",
  "contextTitle": "Rubrik för bakgrundsruta (valfritt, lämna tom sträng om ej relevant)",
  "contextBody": "2-3 meningar bakgrund för läsare som inte följt ämnet (valfritt)"
}

Skriv i GRID:s stil: direkt, berättande, utan onödig jargong. Rubriken ska inte ha punkt.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();
  const text = data.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── PIPELINE ────────────────────────────────────────────────
async function runPipeline() {
  if (!pipelineEnabled) return;
  if (drafts.length >= 10) return; // max 10 pending drafts

  const startTime = Date.now();
  log('Pipeline startar...');

  try {
    const items = await fetchAllFeeds();
    log(`Hämtade ${items.length} artiklar från ${Object.keys(SOURCES).length} källor`);

    const groups = groupByTopic(items);
    log(`Hittade ${groups.length} potentiella trender`);

    if (!groups.length) { log('Inga trender denna körning'); return; }

    // Generate article for top group only (cost control)
    const top = groups[0];

    // Don't regenerate if we already have a draft on this keyword
    if (drafts.find(d => d.keyword === top.keyword && d.status === 'pending')) {
      log(`Utkast för "${top.keyword}" finns redan`);
      return;
    }

    log(`Genererar artikel om: "${top.keyword}" (${top.items.length} källor)`);
    const article = await generateArticle(top);

    const draft = {
      id: 'draft-' + Date.now(),
      keyword: top.keyword,
      article,
      sources: top.items,
      status: 'pending',
      createdAt: new Date().toISOString(),
      generatedIn: Date.now() - startTime
    };

    drafts.unshift(draft);
    cache.del('feed'); // invalidate feed cache
    log(`✓ Utkast skapat: "${article.title}" på ${draft.generatedIn}ms`);

  } catch(e) {
    log(`✕ Pipeline fel: ${e.message}`);
  }

  lastRun = new Date().toISOString();
}

function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  pipelineLog.unshift(entry);
  pipelineLog = pipelineLog.slice(0, 50);
  console.log(`[PIPELINE] ${msg}`);
}

// Run pipeline every 15 minutes
setInterval(runPipeline, 15 * 60 * 1000);
// Also run once on startup after 10 seconds
setTimeout(runPipeline, 10000);

// ─── API ROUTES ───────────────────────────────────────────────
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

app.get('/api/feed/:source', async (req, res) => {
  const source = SOURCES[req.params.source];
  if (!source) return res.status(404).json({ error: 'Not found' });
  const items = await fetchFeed(req.params.source, source);
  res.json(items);
});

// Drafts
app.get('/api/drafts', (req, res) => res.json(drafts));

app.post('/api/drafts/:id/publish', (req, res) => {
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Not found' });
  draft.status = 'published';
  const article = {
    id: 'art-' + Date.now(),
    ...draft.article,
    sources: draft.sources,
    pubDate: new Date().toISOString(),
    aiGenerated: true,
    type: 'grid'
  };
  articles.unshift(article);
  res.json(article);
});

app.post('/api/drafts/:id/reject', (req, res) => {
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Not found' });
  draft.status = 'rejected';
  res.json({ ok: true });
});

app.patch('/api/drafts/:id', (req, res) => {
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Not found' });
  Object.assign(draft.article, req.body);
  res.json(draft);
});

// Articles (CMS)
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/articles', (req, res) => {
  const article = { id: 'art-' + Date.now(), ...req.body, pubDate: new Date().toISOString(), type: 'grid' };
  articles.unshift(article);
  res.json(article);
});

// Pipeline control
app.get('/api/pipeline/status', (req, res) => {
  res.json({ enabled: pipelineEnabled, lastRun, drafts: drafts.length, log: pipelineLog.slice(0, 20) });
});

app.post('/api/pipeline/toggle', (req, res) => {
  pipelineEnabled = !pipelineEnabled;
  log(pipelineEnabled ? 'Pipeline aktiverad' : 'Pipeline pausad');
  res.json({ enabled: pipelineEnabled });
});

app.post('/api/pipeline/run', async (req, res) => {
  res.json({ ok: true, message: 'Pipeline startar...' });
  runPipeline();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRID backend på port ${PORT}`));
