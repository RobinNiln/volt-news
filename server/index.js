const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');

const app = express();
const parser = new Parser({ timeout: 10000 });
const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache

app.use(cors());
app.use(express.json());

const SOURCES = {
  // Riksmedier
  aftonbladet:  { name: 'Aftonbladet',  code: 'AB',  color: '#e8001a', url: 'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/' },
  expressen:    { name: 'Expressen',    code: 'EX',  color: '#006AA7', url: 'https://feeds.expressen.se/nyheter/' },
  dn:           { name: 'DN',           code: 'DN',  color: '#1a1a1a', url: 'https://www.dn.se/rss/' },
  svd:          { name: 'SvD',          code: 'SvD', color: '#002E6E', url: 'https://www.svd.se/feed/articles.rss' },
  sydsvenskan:  { name: 'Sydsvenskan',  code: 'SDS', color: '#D92B3A', url: 'https://www.sydsvenskan.se/rss.xml' },
  gp:           { name: 'GP',           code: 'GP',  color: '#005B99', url: 'https://www.gp.se/feed/articles.rss' },
  barometern:   { name: 'Barometern',   code: 'BAR', color: '#2B6E3A', url: 'https://www.barometern.se/rss/' },
  // Lokala
  norran:       { name: 'Norran',       code: 'NOR', color: '#555', url: 'https://www.norran.se/rss/' },
  nsd:          { name: 'NSD',          code: 'NSD', color: '#555', url: 'https://www.nsd.se/rss/' },
  unt:          { name: 'UNT',          code: 'UNT', color: '#555', url: 'https://www.unt.se/rss/' },
  nt:           { name: 'NT',           code: 'NT',  color: '#555', url: 'https://www.nt.se/rss/' },
  ostgota:      { name: 'Östgöta Correspondenten', code: 'ÖC', color: '#555', url: 'https://www.corren.se/rss/' },
};

// Fetch single RSS feed
async function fetchFeed(key, source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 15).map(item => ({
      id: item.guid || item.link,
      title: item.title,
      link: item.link,
      pubDate: item.pubDate || item.isoDate,
      source: source.name,
      sourceCode: source.code,
      sourceColor: source.color,
      type: 'external'
    }));
  } catch(e) {
    console.error(`Failed to fetch ${key}:`, e.message);
    return [];
  }
}

// GET /api/feed — all sources merged, sorted by date
app.get('/api/feed', async (req, res) => {
  const cached = cache.get('feed');
  if (cached) return res.json(cached);

  const results = await Promise.allSettled(
    Object.entries(SOURCES).map(([key, src]) => fetchFeed(key, src))
  );

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 100);

  cache.set('feed', all);
  res.json(all);
});

// GET /api/feed/:source — single source
app.get('/api/feed/:source', async (req, res) => {
  const source = SOURCES[req.params.source];
  if (!source) return res.status(404).json({ error: 'Source not found' });
  const cacheKey = `feed_${req.params.source}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  const items = await fetchFeed(req.params.source, source);
  cache.set(cacheKey, items);
  res.json(items);
});

// GET /api/sources — list all sources
app.get('/api/sources', (req, res) => {
  res.json(Object.entries(SOURCES).map(([key, s]) => ({
    key, name: s.name, code: s.code, color: s.color
  })));
});

// POST /api/articles — save a CMS article (in-memory for now)
const articles = [];
app.post('/api/articles', (req, res) => {
  const article = {
    id: Date.now().toString(),
    ...req.body,
    pubDate: new Date().toISOString(),
    source: 'GRID',
    sourceCode: 'GRID',
    type: 'grid'
  };
  articles.unshift(article);
  res.json(article);
});

// GET /api/articles — get CMS articles
app.get('/api/articles', (req, res) => {
  res.json(articles);
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', sources: Object.keys(SOURCES).length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRID backend running on port ${PORT}`));
