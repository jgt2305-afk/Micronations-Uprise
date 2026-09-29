const express = require('express'), { Pool } = require('pg'), path = require('path');
const app = express(); app.use(express.json()); app.use(express.static(path.join(__dirname, 'public')));
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jacobgtate@outlook.com';
const db = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: /railway\.internal|localhost/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false } });
const q = (s, p) => db.query(s, p).then(r => r.rows);
const LIMITS = { land: 50, navy: 5, base: 3 }; // above these (or above troop potential) => needs approval email

(async () => { await q(`
create table if not exists nations(id serial primary key, name text unique not null, leader text, token text not null,
  climate text default 'temperate', economy int default 3, resources int default 3, population int default 100, created timestamptz default now());
create table if not exists assets(id serial primary key, nation_id int references nations(id) on delete cascade, type text not null,
  name text, qty numeric default 1, lat float, lng float, status text default 'active', reason text, created timestamptz default now());
create table if not exists laws(id serial primary key, nation_id int references nations(id) on delete cascade, title text, body text, created timestamptz default now());
create table if not exists wars(id serial primary key, attacker int references nations(id), defender int references nations(id),
  reason text, status text default 'active', log jsonb default '[]', created timestamptz default now());`); })().catch(console.error);

const CLIMATE = { temperate: 1, tropical: .9, arid: .8, arctic: .7, mountain: 1.1 };
// Troop potential = population x 2% x climate x economy x resources x land bonus
const potential = (n, land) => Math.floor(n.population * 0.02 * (CLIMATE[n.climate] || 1) * (0.5 + n.economy / 10)
  * (0.75 + n.resources / 20) * (1 + Math.log(1 + land) / 10));

async function auth(req, res, id) {
  const [n] = await q('select * from nations where id=$1 and token=$2', [id, req.headers['x-token'] || '']);
  if (!n) res.status(403).json({ error: 'Bad nation token' });
  return n;
}
async function totals(id) {
  const rows = await q(`select type, coalesce(sum(qty),0)::float t from assets where nation_id=$1 and status='active' group by type`, [id]);
  return Object.fromEntries(rows.map(r => [r.type, r.t]));
}
async function notify(subject, body) {
  if (!process.env.SMTP_HOST) return;
  try { const t = require('nodemailer').createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await t.sendMail({ from: process.env.SMTP_USER, to: ADMIN_EMAIL, subject, text: body }); } catch (e) { console.error(e.message); }
}
const wrap = f => (req, res) => f(req, res).catch(e => res.status(500).json({ error: e.message }));

app.get('/api/state', wrap(async (_, res) => {
  const ns = await q('select id,name,leader,climate,economy,resources,population from nations order by id');
  const as = await q(`select * from assets where status<>'rejected' order by id`);
  for (const n of ns) {
    const mine = as.filter(a => a.nation_id === n.id && a.status === 'active');
    const sum = t => mine.filter(a => a.type === t).reduce((s, a) => s + +a.qty, 0);
    Object.assign(n, { land: sum('land'), troops: sum('troops'), navy: sum('navy'), bases: sum('base') });
    n.potential = potential(n, n.land);
  }
  res.json({ nations: ns, assets: as, laws: await q('select * from laws order by id desc limit 100'),
    wars: await q('select * from wars order by id desc limit 50') });
}));

app.post('/api/nations', wrap(async (req, res) => {
  const b = req.body, token = require('crypto').randomBytes(16).toString('hex');
  if (!b.name) return res.status(400).json({ error: 'Name required' });
  const [n] = await q('insert into nations(name,leader,token,climate,economy,resources,population) values($1,$2,$3,$4,$5,$6,$7) returning id',
    [b.name, b.leader, token, b.climate || 'temperate', clamp(b.economy), clamp(b.resources), Math.max(1, +b.population || 100)]);
  res.json({ id: n.id, token });
}));
const clamp = v => Math.min(10, Math.max(1, +v || 3));

app.patch('/api/nations/:id', wrap(async (req, res) => {
  const n = await auth(req, res, req.params.id); if (!n) return; const b = req.body;
  await q('update nations set population=$2,economy=$3,resources=$4,climate=$5 where id=$1', [n.id,
    Math.max(1, +b.population || n.population), clamp(b.economy ?? n.economy), clamp(b.resources ?? n.resources), b.climate || n.climate]);
  res.json({ ok: true });
}));

app.post('/api/nations/:id/assets', wrap(async (req, res) => {
  const n = await auth(req, res, req.params.id); if (!n) return;
  const { type, name, qty = 1, lat, lng, reason } = req.body;
  if (!['land', 'troops', 'navy', 'base'].includes(type)) return res.status(400).json({ error: 'Bad type' });
  const amt = Math.max(0, +qty || 0), t = await totals(n.id), cur = t[type] || 0;
  const limit = type === 'troops' ? potential(n, t.land || 0) : LIMITS[type];
  const over = cur + amt > limit;
  const [a] = await q('insert into assets(nation_id,type,name,qty,lat,lng,status,reason) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
    [n.id, type, name, amt, lat || null, lng || null, over ? 'pending' : 'active', reason || null]);
  if (!over) return res.json({ status: 'active' });
  const subject = `[Micronation] Approval request #${a.id}: ${n.name} wants ${amt} ${type}`;
  const body = `${n.name} requests ${amt} ${type} (current ${cur}, limit ${limit}).\nRequest ID: ${a.id}\nReason: ${reason || '(none - please explain)'}`;
  notify(subject, body);
  res.json({ status: 'pending', id: a.id, limit, mailto: `mailto:${ADMIN_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` });
}));

app.post('/api/nations/:id/laws', wrap(async (req, res) => {
  const n = await auth(req, res, req.params.id); if (!n) return;
  await q('insert into laws(nation_id,title,body) values($1,$2,$3)', [n.id, req.body.title, req.body.body]); res.json({ ok: true });
}));

app.post('/api/wars', wrap(async (req, res) => {
  const n = await auth(req, res, req.body.attacker); if (!n) return;
  if (+req.body.defender === n.id) return res.status(400).json({ error: 'Cannot fight yourself' });
  const [w] = await q('insert into wars(attacker,defender,reason) values($1,$2,$3) returning id', [n.id, req.body.defender, req.body.reason]);
  res.json(w);
}));

const power = async id => { const t = await totals(id); return (t.troops || 0) + (t.navy || 0) * 20 + (t.base || 0) * 50; };
const casualty = (id, rate) => q(`update assets set qty=floor(qty*(1-$2)) where nation_id=$1 and type in ('troops','navy') and status='active'`, [id, rate]);

app.post('/api/wars/:id/round', wrap(async (req, res) => {
  const [w] = await q('select * from wars where id=$1 and status=$2', [req.params.id, 'active']);
  if (!w) return res.status(404).json({ error: 'No active war' });
  const n = await auth(req, res, w.attacker); if (!n) return;
  const [pa, pd] = [await power(w.attacker) * (0.8 + Math.random() * .4), await power(w.defender) * (0.8 + Math.random() * .4)];
  const winner = pa >= pd ? w.attacker : w.defender, loser = winner === w.attacker ? w.defender : w.attacker;
  await casualty(loser, 0.2); await casualty(winner, 0.08);
  const names = Object.fromEntries((await q('select id,name from nations')).map(r => [r.id, r.name]));
  let text = `Round: ${names[winner]} wins the engagement against ${names[loser]} (${Math.round(pa)} vs ${Math.round(pd)}).`;
  if (process.env.ANTHROPIC_API_KEY) try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 200,
        messages: [{ role: 'user', content: `Write a 2-sentence dramatic war-report for a micronation game. ${text} Cause of war: ${w.reason}` }] }) });
    text = (await r.json()).content?.[0]?.text || text; } catch (e) { /* keep plain text */ }
  await q(`update wars set log = log || $2::jsonb where id=$1`, [w.id, JSON.stringify([{ t: new Date(), text }])]);
  res.json({ text });
}));

app.post('/api/wars/:id/end', wrap(async (req, res) => {
  const [w] = await q('select * from wars where id=$1', [req.params.id]);
  const n = w && (await auth(req, res, w.attacker)); if (!n) return;
  await q(`update wars set status='ended' where id=$1`, [w.id]); res.json({ ok: true });
}));

app.post('/api/admin/assets/:id/:decision', wrap(async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Admin only' });
  await q('update assets set status=$2 where id=$1', [req.params.id, req.params.decision === 'approve' ? 'active' : 'rejected']);
  res.json({ ok: true });
}));

app.listen(process.env.PORT || 3000, () => console.log('Micronation sim running'));
