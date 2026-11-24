// SAM VS MATT BETTING TRACKER
// ─── CONFIG ───────────────────────────────────────────────────────────────────
var BET_AMOUNT = 5;          // default payout per winning bet (change here only)
var RECENT_GAMES_COUNT = 49; // how many sheet rows to show in Recent Games

// ── Odds cache config ──────────────────────────────────────────────────────
var ODDS_CACHE_SHEET = 'OddsCache';   // hidden tab: league | json | fetchedAt(ms)
var ODDS_TTL_MS = 30 * 60 * 1000;     // 30 min: odds come free from ESPN, so refresh often (new lines show up)
var ODDS_FAIL_TTL_MS = 60 * 1000;     // 60s: negative-cache window after a failed pull
var PICK_GRACE_MS = 15 * 60 * 1000;   // picks stay open this long after start (delays), then lock
var CLOSE_LINE_LEAGUES = ['NHL', 'MLB']; // game lines filtered to near 50/50
var GAME_LINE_BAND = [0.45, 0.55];       // no-vig chance a game line must fall in (NHL/MLB)
// ────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('\u{1F3C8} Bet Tracker')
    .addItem('Open Sidebar', 'showSidebar')
    .addItem('Rebuild Summary', 'buildSummary')
    .addToUi();
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('\u{1F3C8} Sam vs Matt')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

function score110(odds) { return Math.abs(Math.abs(odds) - 110); }
function fmt(n) { return (n===null||n===undefined)?'?':(n>0?'+'+n:''+n); }
// Winner cell -> 'Matt' | 'Sam' | null. Splits (draws/pushes) and blanks return
// null so they never count as a win or a loss.
function normWinner_(v) {
  var w = (v||'').toString().trim().toLowerCase();
  return w==='matt' ? 'Matt' : w==='sam' ? 'Sam' : null;
}

function getSportKey(league) {
  var map = {
    'NFL':'americanfootball_nfl',
    'NCAA F':'americanfootball_ncaaf',
    'NCAA MBB':'basketball_ncaab',
    'NBA':'basketball_nba',
    'MLB':'baseball_mlb',
    'NHL':'icehockey_nhl',
    'PGA Tour':'golf_pga_tour',
    'Golf Majors':'golf_masters_tournament_winner',
    'NCAA WBB': 'basketball/womens-college-basketball',
    'NCAA MH':  'hockey/mens-college-hockey',
    'Premier League': 'soccer_epl',
    'Champions League': 'soccer_uefa_champs_league'
  };
  return map[league]||null;
}

function getEspnSportKey(league) {
  var map = {
    'NFL':'football/nfl',
    'NCAA F':'football/college-football',
    'NCAA MBB':'basketball/mens-college-basketball',
    'NBA':'basketball/nba',
    'MLB':'baseball/mlb',
    'NHL':'hockey/nhl',
    'PGA Tour':'golf',
    'Golf Majors':'golf',
    'Premier League':'soccer/eng.1',
    'Champions League':'soccer/uefa.champions'
  };
  return map[league]||null;
}

function normTeam(s) {
  return (s||'').toLowerCase()
    .replace(/[^a-z0-9\s]/g,'')
    .replace(/\b(red raiders|crimson tide|golden flashes|golden eagles|blue raiders|red storm|blue hens|scarlet knights|fighting illini|tar heels|blue devils|wolfpack|orange|crimson|red|golden)\b/g,'')
    .replace(/\s+/g,' ').trim();
}

// Normalize international/soccer team names for matching
function normSoccerTeam(s) {
  return (s||'').toLowerCase()
    .replace(/\./g,' ')        // "Dem. Rep." → "Dem  Rep"
    .replace(/[^a-z0-9\s]/g,'')
    .replace(/\b(fc|sc|cf)\b/g,'')
    .replace(/\s+/g,' ').trim();
}

function soccerTeamsMatch(a, b) {
  if (!a||!b) return false;
  var na = normSoccerTeam(a), nb = normSoccerTeam(b);
  if (!na||!nb) return false;
  if (na===nb) return true;
  if (na.indexOf(nb)>=0 || nb.indexOf(na)>=0) return true;
  // Handle "DR Congo" vs "Congo DR" vs "Democratic Republic of Congo" vs "Dem. Rep. Congo"
  var wa = na.split(' '), wb = nb.split(' ');
  // If all words from the shorter name appear in the longer name
  var sh = wa.length <= wb.length ? wa : wb;
  var lo = wa.length <= wb.length ? nb : na;
  if (sh.length >= 1 && sh.every(function(w){ return w.length >= 3 && lo.indexOf(w) >= 0; })) return true;
  // Check if last word matches (e.g., "Congo" in both)
  if (wa[wa.length-1] === wb[wb.length-1] && wa[wa.length-1].length >= 4) return true;
  if (wa[0] === wb[0] && wa[0].length >= 4) return true;
  return false;
}

function teamsMatch(a, b) {
  if (!a||!b) return false;
  var na = normTeam(a), nb = normTeam(b);
  if (!na||!nb) return false;
  if (na===nb) return true;
  if (na.indexOf(nb)>=0 || nb.indexOf(na)>=0) return true;
  var fa = na.split(' ')[0], fb = nb.split(' ')[0];
  if (fa.length >= 2 && fa === fb) return true;
  var wa = na.split(' '), wb = nb.split(' ');
  if (wa[wa.length-1]===wb[wb.length-1] && wa[wa.length-1].length>=3) return true;
  if (Math.abs(wa.length-wb.length)<=1) {
    var sh=wa.length<=wb.length?wa:wb, lo=wa.length<=wb.length?nb:na;
    if (sh.every(function(w){return w.length>=3&&lo.indexOf(w)>=0;})) return true;
  }
  return false;
}

// ── Sheet-backed odds cache ──────────────────────────────────────────────────
// CacheService is fast but can be evicted before its TTL. A hidden sheet gives
// us a durable second layer so re-selecting a league doesn't re-hit the slow
// Odds API. Layout: OddsCache tab with rows [league, json, fetchedAt(ms)].
function getOddsCacheSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ODDS_CACHE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ODDS_CACHE_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['league', 'json', 'fetchedAt']]);
    sh.hideSheet();
  }
  return sh;
}

function readOddsCache_(league) {
  try {
    var sh = getOddsCacheSheet_();
    var last = sh.getLastRow();
    if (last < 2) return null;
    var vals = sh.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0] === league) {
        return { json: vals[i][1], fetchedAt: Number(vals[i][2]) || 0, row: i + 2 };
      }
    }
  } catch (e) {}
  return null;
}

function writeOddsCache_(league, jsonStr) {
  try {
    var sh = getOddsCacheSheet_();
    var existing = readOddsCache_(league);
    var now = Date.now();
    if (existing) {
      sh.getRange(existing.row, 2, 1, 2).setValues([[jsonStr, now]]);
    } else {
      sh.appendRow([league, jsonStr, now]);
    }
  } catch (e) {}
}

// True while a game is still pickable: before start + PICK_GRACE_MS.
// Unknown/unparseable start time = open (manual entries have no start time).
function isPickOpen_(commenceTime, nowMs) {
  var t = new Date(commenceTime).getTime();
  if (!commenceTime || isNaN(t)) return true;
  return (nowMs || Date.now()) < t + PICK_GRACE_MS;
}

// Cached game lists are snapshots from fetch time, so re-apply the lock window
// on every read; otherwise a 6h-old cache can still offer games that started.
function getGamesForLeague(league) {
  var games = fetchGamesForLeague_(league);
  if (!games.length || games[0].error) return games;
  var now = Date.now();
  return games.filter(function(g) { return isPickOpen_(g.commenceTime, now); })
    .map(function(g) { g.startingSoon = new Date(g.commenceTime).getTime() <= now; return g; });
}

// The Odds API key lives in Script Properties (Project Settings > Script Properties >
// ODDS_API_KEY), not in code, because this repo is public.
function oddsApiKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('ODDS_API_KEY');
  if (!k) throw new Error('ODDS_API_KEY is not set in Script Properties');
  return k;
}

// ── Odds API credits ─────────────────────────────────────────────────────────
// Free plan: 500 credits/month. Every Odds API response reports credits left; we remember
// the last value and email once when it drops below ODDS_API_ALERT_BELOW (re-arms when the
// monthly reset brings it back up). Paid lookups stop at ODDS_API_FLOOR.
var ODDS_API_FLOOR = 20;          // never spend below this many credits
var ODDS_API_ALERT_BELOW = 100;   // email alert threshold

// Emails live in Script Properties MATT_EMAIL and SAM_EMAIL, not in this public repo.
// CREDIT_ALERT_TO picks who gets the low-credit email: matt (default), sam, or both.
function personEmail_(who) {
  return PropertiesService.getScriptProperties().getProperty(who === 'sam' ? 'SAM_EMAIL' : 'MATT_EMAIL') || '';
}

function creditAlertRecipients_(props) {
  var pick = String(props.getProperty('CREDIT_ALERT_TO') || 'matt').toLowerCase().trim();
  var list = pick === 'both' ? [personEmail_('matt'), personEmail_('sam')] : [personEmail_(pick)];
  return list.filter(function(e) { return e; }).join(',');
}

function oddsCreditsLeft_() {
  var v = PropertiesService.getScriptProperties().getProperty('ODDS_CREDITS_LEFT');
  return v === null || v === '' || isNaN(Number(v)) ? null : Number(v);
}

function noteOddsApiCredits_(resp) {
  var left = Number(headerVal_(resp, 'x-requests-remaining'));
  if (isNaN(left)) return;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ODDS_CREDITS_LEFT', String(left));
  var sent = props.getProperty('ODDS_LOW_ALERT_SENT') === '1';
  if (left >= ODDS_API_ALERT_BELOW) { if (sent) props.deleteProperty('ODDS_LOW_ALERT_SENT'); return; }
  if (sent) return;
  var to = creditAlertRecipients_(props) || Session.getEffectiveUser().getEmail();
  if (!to) return;
  try {
    MailApp.sendEmail({ to: to, subject: 'Matt vs Sam: Odds API credits low (' + left + ' left)',
      body: 'The Odds API has ' + left + ' credits left this month (free plan: 500).\n\n' +
            'Regular game odds come free from ESPN and are not affected.\n' +
            'College football player props cost 4 credits per game and switch off at ' + ODDS_API_FLOOR + ' credits left.\n' +
            'Credits reset monthly; this alert re-arms after the reset.' });
    props.setProperty('ODDS_LOW_ALERT_SENT', '1');
  } catch (e) {}
}

// Run from the Apps Script editor to see credits left. The /sports call is free.
function checkOddsApiCredits() {
  var r = UrlFetchApp.fetch('https://api.the-odds-api.com/v4/sports?apiKey=' + encodeURIComponent(oddsApiKey_()),
                            { muteHttpExceptions: true });
  noteOddsApiCredits_(r);
  Logger.log('HTTP ' + r.getResponseCode() + ' | credits used ' + headerVal_(r, 'x-requests-used') +
             ', remaining ' + headerVal_(r, 'x-requests-remaining'));
}

// ── Main odds from ESPN (free) ───────────────────────────────────────────────
// ESPN scoreboards carry DraftKings spread / moneyline / total prices. Football is priced
// days ahead; NBA/NHL/college hoops lines appear about a day before (checked 2026-11-23).
var ESPN_ODDS_DAYS = 8;   // today + next 7 days

// Today + the next 7 days of ESPN games, converted to the Odds API event shape so the
// existing option-building code is reused unchanged. Returns null if ESPN can't be reached.
function fetchEspnOddsEvents_(league, espnKey) {
  var groups = league === 'NCAA MBB' ? '&groups=50' : league === 'NCAA F' ? '&groups=80' : '';
  var reqs = [];
  for (var d = 0; d < ESPN_ODDS_DAYS; d++) {
    var ds = Utilities.formatDate(new Date(Date.now() + d * 86400000), 'America/Chicago', 'yyyyMMdd');
    reqs.push({ url: 'https://site.web.api.espn.com/apis/site/v2/sports/' + espnKey + '/scoreboard?dates=' + ds +
                     '&limit=300' + groups, muteHttpExceptions: true });
  }
  var reached = 0, seen = {}, out = [];
  UrlFetchApp.fetchAll(reqs).forEach(function(r) {
    var j = null;
    try { if (r.getResponseCode() === 200) j = JSON.parse(r.getContentText()); } catch (e) {}
    if (!j) return;
    reached++;
    (j.events || []).forEach(function(ev) {
      if (seen[ev.id]) return;
      seen[ev.id] = 1;
      var g = espnEventToOddsShape_(ev);
      if (g) out.push(g);
    });
  });
  return reached ? out : null;
}

// "+170" -> 170, "-110" -> -110, "EVEN" -> 100, missing -> null.
function espnPrice_(v) {
  var s = String(v == null ? '' : v).trim();
  if (/^even$/i.test(s)) return 100;
  var n = Number(s.replace('+', ''));
  return s && !isNaN(n) ? n : null;
}

// Pure: one ESPN scoreboard event -> {home_team, away_team, commence_time, bookmakers:[...]}.
// Only upcoming/in-progress games with at least one fully priced market are returned.
function espnEventToOddsShape_(ev) {
  var state = ((ev.status || {}).type || {}).state;
  if (state !== 'pre' && state !== 'in') return null;
  var comp = (ev.competitions || [])[0] || {}, home = null, away = null;
  (comp.competitors || []).forEach(function(c) { if (c.homeAway === 'home') home = c; else away = c; });
  if (!home || !away) return null;
  var odds = comp.odds || [];
  var o = odds.filter(function(x) { return String((x.provider || {}).id) === String(ESPN_PROVIDER_DK); })[0] || odds[0];
  if (!o) return null;
  var H = (home.team || {}).displayName, A = (away.team || {}).displayName;
  var cl = function(side) { return (side || {}).close || {}; };
  var mkts = [];
  var ps = o.pointSpread || {}, hs = cl(ps.home), as = cl(ps.away);
  var hp = parseFloat(hs.line), ap = parseFloat(as.line);
  if (!isNaN(hp) && !isNaN(ap) && espnPrice_(hs.odds) !== null && espnPrice_(as.odds) !== null) {
    mkts.push({ key: 'spreads', outcomes: [{ name: H, point: hp, price: espnPrice_(hs.odds) },
                                           { name: A, point: ap, price: espnPrice_(as.odds) }] });
  }
  var ml = o.moneyline || {}, hm = espnPrice_(cl(ml.home).odds), am = espnPrice_(cl(ml.away).odds);
  if (hm !== null && am !== null) mkts.push({ key: 'h2h', outcomes: [{ name: H, price: hm }, { name: A, price: am }] });
  var t = o.total || {}, ov = cl(t.over), un = cl(t.under);
  var tl = parseFloat(String(ov.line || '').replace(/^[ou]/i, ''));
  if (!isNaN(tl) && espnPrice_(ov.odds) !== null && espnPrice_(un.odds) !== null) {
    mkts.push({ key: 'totals', outcomes: [{ name: 'Over', point: tl, price: espnPrice_(ov.odds) },
                                          { name: 'Under', point: tl, price: espnPrice_(un.odds) }] });
  }
  if (!mkts.length) return null;
  // Same start-time format the Odds API used ("2026-11-27T17:00:00Z") so duplicate checks keep matching.
  return { home_team: H, away_team: A, commence_time: new Date(ev.date).toISOString().replace('.000Z', 'Z'),
           bookmakers: [{ key: 'draftkings', markets: mkts }] };
}

function fetchGamesForLeague_(league) {
  var cacheKey = 'odds_' + league.replace(/\s/g, '_');
  var cache = CacheService.getScriptCache();
  try {
    var sportKey = getSportKey(league);
    if (!sportKey) return [];

    // ── Layer 1: fast in-memory script cache (fresh results only) ────────────
    var cached = cache.get(cacheKey);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;   // includes [] (off-season / no lines) so empty leagues aren't re-fetched
      // note: a __fail marker here does NOT short-circuit — we still prefer to
      // serve durable cache (below) or attempt a fresh pull. The marker only
      // becomes the answer at the very end if nothing else works.
    }

    // ── Layer 2: durable sheet-backed cache (serve if fresh) ─────────────────
    var durable = readOddsCache_(league);
    var durParsedGlobal = null;
    if (durable && durable.json) {
      try { durParsedGlobal = JSON.parse(durable.json); } catch (e) { durParsedGlobal = null; }
    }
    if (durParsedGlobal && durParsedGlobal.length && (Date.now() - durable.fetchedAt) < ODDS_TTL_MS) {
      try { cache.put(cacheKey, durable.json, Math.round((ODDS_TTL_MS - (Date.now() - durable.fetchedAt)) / 1000) || 1); } catch (e) {}
      return durParsedGlobal;
    }

    // If we recently failed AND have any usable stale cache, serve the stale
    // copy rather than re-hitting a flaky upstream. Only fall through to a live
    // pull when we have nothing to show.
    if (cached) {
      var p2 = JSON.parse(cached);
      if (p2 && p2.__fail && durParsedGlobal && durParsedGlobal.length) {
        return durParsedGlobal;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Main odds come free from ESPN (DraftKings lines). The Odds API (3 credits per pull) is only
    // a backup for when ESPN can't be reached, and only while credits are above ODDS_API_FLOOR.
    var espnKey = getEspnSportKey(league);
    var data = (espnKey && espnKey !== 'golf') ? fetchEspnOddsEvents_(league, espnKey) : null;
    var lastCode = 0, fromOddsApi = false;
    var creditsLeft = oddsCreditsLeft_();
    if (!Array.isArray(data) && creditsLeft !== null && creditsLeft - 3 < ODDS_API_FLOOR) {
      lastCode = 'ESPN down; Odds API backup paused, ' + creditsLeft + ' credits left';
    } else if (!Array.isArray(data)) {
      var url = 'https://api.the-odds-api.com/v4/sports/' + sportKey +
        '/odds/?apiKey=' + encodeURIComponent(oddsApiKey_()) + '&regions=us&markets=spreads,h2h,totals&oddsFormat=american&dateFormat=iso';

      // One quick retry smooths over transient upstream hiccups (the main cause
      // of intermittent "error loading games").
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
          noteOddsApiCredits_(resp);
          lastCode = resp.getResponseCode();
          if (lastCode >= 200 && lastCode < 300) {
            try { var d = JSON.parse(resp.getContentText()); if (Array.isArray(d)) { data = d; fromOddsApi = true; break; } } catch (e) {}
          }
        } catch (e) {}
        if (attempt === 0) Utilities.sleep(800); // brief backoff before retry
      }
    }

    if (!Array.isArray(data)) {
      // Both attempts failed. Serve ANY stale durable cache before erroring.
      if (durParsedGlobal && durParsedGlobal.length) return durParsedGlobal;
      try { cache.put(cacheKey, JSON.stringify({ __fail: true }), Math.round(ODDS_FAIL_TTL_MS / 1000)); } catch (e) {}
      return [{ error: 'Odds temporarily unavailable (' + (typeof lastCode === 'number' ? 'HTTP ' : '') + lastCode + ')', retryAfter: true }];
    }

    var isCollege = (league === 'NCAA F' || league === 'NCAA MBB');
    // Soccer leagues use full team names (no abbreviation needed)
    var isSoccer = (league === 'Premier League' || league === 'Champions League');
    var now = new Date();
    var cutoff = new Date(now.getTime() - PICK_GRACE_MS);

    function sn(n) {
      if (isSoccer) return n; // keep full team name for soccer
      var p = n.split(' ');
      return isCollege ? p.slice(0, -1).join(' ') : p[p.length - 1];
    }

    var games = [];
    for (var gi = 0; gi < data.length; gi++) {
      var g = data[gi];
      var commenceTime = new Date(g.commence_time);
      if (commenceTime < cutoff) continue;

      var localDate = Utilities.formatDate(commenceTime, 'America/Chicago', 'yyyy-MM-dd');
      var localDateTime = Utilities.formatDate(commenceTime, 'America/Chicago', 'M/d h:mm a');
      var startingSoon = commenceTime >= cutoff && commenceTime <= now;

      var spread = null, ml = null, ovun = null;
      var bks = g.bookmakers || [];
      for (var bi = 0; bi < bks.length; bi++) {
        var mkts = bks[bi].markets || [];
        for (var mi = 0; mi < mkts.length; mi++) {
          var mkt = mkts[mi], outs = mkt.outcomes || [];
          if (mkt.key === 'spreads' && !spread) {
            var fO = null, dO = null;
            for (var si = 0; si < outs.length; si++) {
              if (outs[si].point < 0) fO = outs[si]; else dO = outs[si];
            }
            // Skip quarter-lines (Asian handicap splits like 0.25, 0.75, 1.25, 1.75)
            // Only allow whole numbers and .5 lines (clear win/loss, no half-bets)
            if (fO) {
              var absLine = Math.abs(fO.point);
              // Round to 2 decimal places to handle floating-point issues
              var frac = Math.round((absLine - Math.floor(absLine)) * 100) / 100;
              var isCleanLine = (frac === 0 || frac === 0.5);
              if (isCleanLine) {
                spread = { favorite: fO.name, line: Math.abs(fO.point), favOdds: fO.price, dogOdds: dO ? dO.price : null };
              }
            }
          }
          if (mkt.key === 'h2h' && !ml) {
            var sorted = outs.slice().sort(function(a, b) { return a.price - b.price; });
            if (sorted.length >= 2) ml = { favorite: sorted[0].name, favOdds: sorted[0].price, dogName: sorted[1].name, dogOdds: sorted[1].price };
          }
          if (mkt.key === 'totals' && !ovun) {
            var ov = null, un = null;
            for (var ti = 0; ti < outs.length; ti++) {
              if (outs[ti].name === 'Over') ov = outs[ti]; else un = outs[ti];
            }
            // Skip quarter-line totals (e.g. 2.25, 2.75) — only whole and .5
            if (ov) {
              var totalFrac = ov.point - Math.floor(ov.point);
              var isCleanTotal = (totalFrac === 0 || totalFrac === 0.5);
              if (isCleanTotal) {
                ovun = { line: ov.point, overOdds: ov.price, underOdds: un ? un.price : null };
              }
            }
          }
        }
        if (spread && ml && ovun) break;
      }

      var options = [];

      // ─── SOCCER: Spread + Totals only (no W/D/L combos — redundant with spread) ──
      if (isSoccer) {
        if (spread) {
          var dt2 = (g.home_team === spread.favorite) ? g.away_team : g.home_team;
          options.push({
            type: 'spread',
            score: Math.min(score110(spread.favOdds), score110(spread.dogOdds || -110)),
            label: 'Spread ' + sn(spread.favorite) + ' -' + spread.line,
            oddsStr: sn(spread.favorite) + ' -' + spread.line + ' (' + fmt(spread.favOdds) + ')  |  ' + sn(dt2) + ' +' + spread.line + ' (' + fmt(spread.dogOdds) + ')',
            favorite: spread.favorite, line: spread.line,
            favOdds: spread.favOdds, dogOdds: spread.dogOdds
          });
        }
        if (ovun) {
          options.push({
            type: 'total',
            score: Math.min(score110(ovun.overOdds), score110(ovun.underOdds || -110)),
            label: 'O/U ' + ovun.line + ' goals',
            oddsStr: 'Over ' + ovun.line + ' (' + fmt(ovun.overOdds) + ')  |  Under ' + ovun.line + ' (' + fmt(ovun.underOdds) + ')',
            favorite: null, line: ovun.line,
            favOdds: ovun.overOdds, dogOdds: ovun.underOdds
          });
        }
      }
      // ─── NON-SOCCER: Standard spread, moneyline, totals (.5 only) ──────────
      else {
        if (spread) {
          var dt = (g.home_team === spread.favorite) ? g.away_team : g.home_team;
          options.push({
            type: 'spread',
            score: Math.min(score110(spread.favOdds), score110(spread.dogOdds || -110)),
            label: 'Spread ' + spread.favorite.split(' ').pop() + ' -' + spread.line,
            oddsStr: spread.favorite.split(' ').pop() + ' -' + spread.line + ' (' + fmt(spread.favOdds) + ')  |  ' + dt.split(' ').pop() + ' +' + spread.line + ' (' + fmt(spread.dogOdds) + ')',
            favorite: spread.favorite, line: spread.line,
            favOdds: spread.favOdds, dogOdds: spread.dogOdds
          });
        }
        if (ml) {
          options.push({
            type: 'moneyline',
            score: Math.min(score110(ml.favOdds), score110(ml.dogOdds)),
            label: 'ML ' + ml.favorite.split(' ').pop() + ' ' + fmt(ml.favOdds),
            oddsStr: ml.favorite.split(' ').pop() + ' ' + fmt(ml.favOdds) + '  |  ' + ml.dogName.split(' ').pop() + ' ' + fmt(ml.dogOdds),
            favorite: ml.favorite, line: null,
            favOdds: ml.favOdds, dogOdds: ml.dogOdds
          });
        }
        if (ovun) {
          // Show all clean totals (whole numbers + .5). Pushes on whole numbers become splits.
          options.push({
            type: 'total',
            score: Math.min(score110(ovun.overOdds), score110(ovun.underOdds || -110)),
            label: 'O/U ' + ovun.line,
            oddsStr: 'Over ' + ovun.line + ' (' + fmt(ovun.overOdds) + ')  |  Under ' + ovun.line + ' (' + fmt(ovun.underOdds) + ')',
            favorite: null, line: ovun.line,
            favOdds: ovun.overOdds, dogOdds: ovun.underOdds
          });
        }
      }
      // NHL / MLB: moneylines and ±1.5 puck/run lines are often lopsided, so only offer
      // lines whose no-vig chance is 45-55%. A game with none left is still listed as
      // "No close line" (player props / periods / team totals may still be available).
      var noCloseLine = false;
      if (CLOSE_LINE_LEAGUES.indexOf(league) >= 0 && options.length) {
        options = options.filter(function(o) {
          if (o.favOdds == null || o.dogOdds == null) return false;
          var pf = impliedProb_(o.favOdds), pd = impliedProb_(o.dogOdds), f = pf / (pf + pd);
          return f >= GAME_LINE_BAND[0] && f <= GAME_LINE_BAND[1];
        });
        noCloseLine = !options.length;
      }
      if (!options.length && !noCloseLine) continue;

      // Sort by "closest to 50/50" (lowest score = closest to -110 on both sides)
      options.sort(function(a, b) { return a.score - b.score; });
      var best = options[0] || { label: 'No close line' };

      games.push({
        homeTeam: g.home_team, awayTeam: g.away_team,
        sheetHome: sn(g.home_team), sheetAway: sn(g.away_team),
        isCollege: isCollege,
        isSoccer: isSoccer,
        label: localDateTime + ' — ' + g.away_team + ' @ ' + g.home_team + ' — ' + (best.label || ''),
        displayDate: localDateTime,
        startingSoon: startingSoon, noCloseLine: noCloseLine,
        options: options, bestType: best.type,
        favorite: best.favorite, line: best.line,
        oddsStr: best.oddsStr, marketType: best.type,
        gameDate: localDate, commenceTime: g.commence_time
      });
    }

    games.sort(function(a, b) { return new Date(a.commenceTime) - new Date(b.commenceTime); });

    // ── Store in both cache layers ───────────────────────────────────────────
    var gamesJson = JSON.stringify(games);
    // Paid backup results are kept 6h (cost 3 credits each); free ESPN results 30 min.
    try { cache.put(cacheKey, gamesJson, fromOddsApi ? 21600 : Math.round(ODDS_TTL_MS / 1000)); } catch(e) {}  // layer 1 (empty lists too)
    if (games.length) writeOddsCache_(league, gamesJson);        // layer 2: durable
    // ────────────────────────────────────────────────────────────────────────

    return games;
  } catch(e) {
    // On unexpected error, prefer serving stale durable cache over a hard error.
    try {
      var d = readOddsCache_(league);
      if (d && d.json) { var p = JSON.parse(d.json); if (p && p.length) return p; }
    } catch (e2) {}
    try { cache.put(cacheKey, JSON.stringify({ __fail: true }), Math.round(ODDS_FAIL_TTL_MS / 1000)); } catch (e3) {}
    return [{ error: e.toString(), retryAfter: true }];
  }
}

function getGamesForDate(league, dateStr) {
  var all = getGamesForLeague(league);
  if (!all.length || all[0].error) return all;
  return all.filter(function(g){ return g.gameDate === dateStr; });
}

function resolveScore(d) {
  try {
    var nums=d.scoreStr.match(/\d+/g);
    if (!nums||nums.length<2) return null;
    var s1=parseInt(nums[0]),s2=parseInt(nums[1]),line=parseFloat(d.line);

    // ─── O/U TOTAL BETS ─────────────────────────────────────────────────────
    // If isTotal flag is passed, compare combined score to the line
    if (d.isTotal) {
      var totalScored = s1 + s2;
      if (totalScored === line) {
        return {winner:'Split',covered:null,margin:totalScored,line:line,isPush:true,isTotal:true};
      }
      var overHits = totalScored > line;
      var winner = overHits ? d.favoritePicker : (d.favoritePicker==='Matt'?'Sam':'Matt');
      return {winner:winner,covered:overHits,margin:totalScored,line:line,isPush:false,isTotal:true};
    }
    // ─────────────────────────────────────────────────────────────────────────

    var favName=(d.favorite||'').toLowerCase();
    var m=d.scoreStr.toLowerCase().match(/^([a-z\s]+?)\s*(\d+)/);
    var favScore,dogScore;
    if (m){
      var ft=m[1].trim(),matchesFav=favName.split(' ').some(function(w){return w.length>3&&ft.indexOf(w)>=0;});
      favScore=matchesFav?s1:s2;
      dogScore=matchesFav?s2:s1;
    }else{
      favScore=Math.max(s1,s2);
      dogScore=Math.min(s1,s2);
    }
    var margin=favScore-dogScore;
    // Push detection: if margin exactly equals line, it's a push (split)
    if (margin === line) {
      return {winner:'Split',covered:null,margin:margin,line:line,isPush:true};
    }
    var covered=margin>line;
    return {winner:covered?d.favoritePicker:(d.favoritePicker==='Matt'?'Sam':'Matt'),covered:covered,margin:margin,line:line,isPush:false};
  } catch(e){return null;}
}

// ─── DUPLICATE DETECTION FIX ─────────────────────────────────────────────────
// Previously matched on game name + date only, which blocked series games
// (same teams, different days or doubleheaders).
// CURRENT LOGIC (betKey_): same game + start time (or date for manual entries) + bet
// type + line + prop/game-bet label = duplicate, whoever took which side and even if
// the odds moved. Different start times (series games) or bet types are allowed.
// ─────────────────────────────────────────────────────────────────────────────
// Pure: when a bet's game happens, for duplicate checks. Start time to the minute when known
// (works whether the sheet cell holds text or a Date); otherwise the game date as M/d/yyyy.
// "yyyy-mm-dd" input dates are read as calendar dates, not UTC midnight.
function betWhen_(commence, date, tz) {
  var t = commence ? new Date(commence).getTime() : NaN;
  if (!isNaN(t)) return 't' + Math.round(t / 60000);
  var m = String(date || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return 'd' + parseInt(m[2], 10) + '/' + parseInt(m[3], 10) + '/' + m[1];
  return date ? 'd' + Utilities.formatDate(new Date(date), tz, 'M/d/yyyy') : '';
}

// Pure: identity of a bet for duplicate checks. Two rows are the same bet when the game
// (either team order), start time, bet type (spread/ML, O/U, PROP, GAME), line and the
// player-prop / game-bet label all match. Who took which side and odds moves don't matter.
function betKey_(game, when, odds, line, propLabel) {
  var teams = String(game || '').toLowerCase().split(' vs ').map(function(s) { return s.trim(); }).sort().join('|');
  var type = (String(odds || '').trim().match(/^(O\/U|PROP|GAME)/i) || ['LINE'])[0].toUpperCase();
  var ln = parseFloat(line);
  if (isNaN(ln)) ln = 0;   // moneyline: app sends '' and the sidebar sends 0
  return [teams, when, type, ln, String(propLabel || '').toLowerCase().trim()].join('#');
}

// One add at a time, so Matt and Sam adding the same bet at the same moment can't both get in.
function addGame(d) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return addGame_(d); } finally { lock.releaseLock(); }
}

function addGame_(d) {
  if (d.commenceTime && !isPickOpen_(d.commenceTime)) {
    return {locked:true, error:'Picks locked: game started more than ' + (PICK_GRACE_MS/60000) + ' min ago'};
  }
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();

  if (lastRow>=2) {
    var existing=sheet.getRange(2,1,lastRow-1,12).getValues();
    var tz = Session.getScriptTimeZone();
    var inputKey = betKey_(d.game, betWhen_(d.commenceTime, d.date, tz), d.odds, d.line, propLabel_(d.prop));
    for (var i=0;i<existing.length;i++){
      var r = existing[i];
      if (!r[2]) continue;
      var eKey = betKey_(r[2], betWhen_(r[10], r[0], tz), r[4], r[3], r[11]);
      if (eKey === inputKey) {
        return {duplicate:true, row:i+2, reason:'This bet is already in the sheet (' + (r[5] || '?') + ' has the first side)'};
      }
    }
  }

  // ─── DATE DERIVATION FIX ─────────────────────────────────────────────────
  // Always derive the display date from commenceTime (in CT) when available.
  // This ensures the Date column and Actual Start Time column are consistent.
  var displayDate;
  if (d.commenceTime) {
    var ct = new Date(d.commenceTime);
    var formatted = Utilities.formatDate(ct, 'America/Chicago', 'M/d/yyyy');
    displayDate = formatted;
  } else {
    var dp = (d.date||'').split('-');
    displayDate = dp.length===3 ? (parseInt(dp[1])+'/'+parseInt(dp[2])+'/'+dp[0]) : d.date;
  }

  var row=sheet.getLastRow()+1;
  sheet.getRange(row,1).setValue(displayDate);
  sheet.getRange(row,2).setValue(d.league);
  sheet.getRange(row,3).setValue(d.game);
  sheet.getRange(row,4).setValue((d.line!==''&&d.line!==null)?parseFloat(d.line):'');
  sheet.getRange(row,5).setValue(d.odds||'');
  sheet.getRange(row,6).setValue(d.favorite);
  sheet.getRange(row,7).setValue('');  // Final Score
  sheet.getRange(row,8).setValue('');  // Winner
  sheet.getRange(row,9).setValue('');  // Amt Won
  sheet.getRange(row,10).setValue(''); // Paid Out
  sheet.getRange(row,11).setValue(d.commenceTime||'');  // Actual Start Time
  if (d.prop) {
    sheet.getRange(row,12).setValue(propLabel_(d.prop));          // Player prop (label)
    sheet.getRange(row,13).setValue(JSON.stringify(propSnapshot_(d.prop))); // Prop snapshot (for grading)
  }

  return {success:true, row:row};
}

// "Ja Morant (MEM) · Points" — shown in the sheet and on the game card.
function propLabel_(p) {
  if (!p) return '';
  return (p.player || '') + (p.team ? ' (' + p.team + ')' : '') + ' · ' + (p.market || '');
}

// Only the fields grading and display need, so the cell stays small.
function propSnapshot_(p) {
  return { player: p.player, team: p.team, opp: p.opp, market: p.market, stat: p.stat, line: p.line,
           overOdds: p.overOdds, underOdds: p.underOdds, impliedOver: p.impliedOver, impliedUnder: p.impliedUnder,
           fairOver: p.fairOver, book: p.book, updated: p.updated, athleteId: p.athleteId,
           eventId: p.eventId, sport: p.sport, espnLeague: p.espnLeague, savedAt: new Date().toISOString(),
           // Game bets (halves/periods/team totals) only:
           kind: p.kind, betType: p.betType, sideA: p.sideA, sideB: p.sideB, sideHome: p.sideHome,
           periods: p.periods, segment: p.segment };
}

function updateGame(d) {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var row=parseInt(d.row);
  sheet.getRange(row,7).setValue(d.finalScore||'');
  sheet.getRange(row,8).setValue(d.winner||'');
  sheet.getRange(row,9).setValue((d.amtWon!==''&&d.amtWon!==null)?parseFloat(d.amtWon):'');
  sheet.getRange(row,10).setValue(d.paidOut?'X':'');
  return {success:true};
}

function getRecentGames() {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();
  if (lastRow<2) return [];
  var start=Math.max(2, lastRow - RECENT_GAMES_COUNT);
  var vals=sheet.getRange(start,1,lastRow-start+1,13).getValues();
  var out=[];
  for (var i=vals.length-1;i>=0;i--){
    var r=vals[i]; if (!r[2]) continue;
    var ct=r[10]?r[10].toString():'';
    var timeStr='';
    if (ct) {
      try {
        timeStr = Utilities.formatDate(new Date(ct),'America/Chicago','h:mm a');
      } catch(e) { timeStr = ''; }
    }
    out.push({
      row:start+i,
      date:r[0]?Utilities.formatDate(new Date(r[0]),Session.getScriptTimeZone(),'M/d'):'',
      league:r[1]||'', game:r[2]||'', line:r[3]||'', odds:r[4]||'',
      favorite:r[5]||'', finalScore:r[6]||'', winner:r[7]||'',
      amtWon:r[8]||'', paidOut:r[9]==='X',
      time:timeStr, commenceTime:ct,
      prop:r[11]||'', propMeta:parsePropMeta_(r[12])
    });
  }
  return out;
}

function parsePropMeta_(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function getPayoutPeriodStats() {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();
  if (lastRow<2) return {mattWins:0,samWins:0,mattLosses:0,samLosses:0,mattNet:0,samNet:0,unpaidBalance:0,absBalance:0,payoutDue:0,owes:'',owed:'',games:[],periodStart:'',daysSinceStart:0};

  var data=sheet.getRange(2,1,lastRow-1,10).getValues();
  var mattWins=0,samWins=0,mattLosses=0,samLosses=0,mattNet=0,samNet=0,unpaidBalance=0;
  var games=[];
  var earliestDate=null;

  for (var i=0;i<data.length;i++){
    var r=data[i];
    if (!r[2]||!r[7]) continue;
    if (r[9]==='X') continue;
    var amt=parseFloat(r[8])||0, winner=normWinner_(r[7]);
    if (!winner) continue; // split: not a win or a loss
    var gameDate=r[0]?new Date(r[0]):null;
    if (gameDate && (!earliestDate || gameDate < earliestDate)) {
      earliestDate = gameDate;
    }
    if (winner==='Matt'){mattWins++;mattNet+=amt;samNet-=amt;samLosses++;unpaidBalance+=amt;}
    else {samWins++;samNet+=amt;mattNet-=amt;mattLosses++;unpaidBalance-=amt;}
    games.push({row:i+2,date:r[0]?Utilities.formatDate(new Date(r[0]),Session.getScriptTimeZone(),'M/d'):'',game:r[2]||'', league:r[1]||'',winner:winner, amt:amt, finalScore:r[6]||''});
  }

  var absBalance=Math.abs(unpaidBalance);
  var periodStart='';
  var daysSinceStart=0;
  if (earliestDate) {
    periodStart=Utilities.formatDate(earliestDate,'America/Chicago','M/d');
    var now=new Date();
    var diffMs=now.getTime()-earliestDate.getTime();
    daysSinceStart=Math.floor(diffMs/(1000*60*60*24));
  }

  return {
    mattWins:mattWins, samWins:samWins,
    mattLosses:mattLosses, samLosses:samLosses,
    mattNet:mattNet, samNet:samNet,
    unpaidBalance:unpaidBalance, absBalance:absBalance,
    payoutDue:Math.floor(absBalance/20)*20,
    owes:unpaidBalance>0?'Sam':'Matt',
    owed:unpaidBalance>0?'Matt':'Sam',
    games:games,
    periodStart:periodStart,
    daysSinceStart:daysSinceStart
  };
}

function processPayout() {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();
  if (lastRow<2) return {success:false,message:'No games found'};

  var data=sheet.getRange(2,1,lastRow-1,10).getValues();
  var unpaid=[];
  for (var i=0;i<data.length;i++){
    var r=data[i];
    if (!r[2]||!r[7]) continue;
    if (r[9]==='X') continue;
    unpaid.push({rowNum:i+2, amt:parseFloat(r[8])||0, winner:r[7], game:r[2]});
  }

  var balance=0;
  unpaid.forEach(function(g){ var w=normWinner_(g.winner); if (w) balance+=(w==='Matt')?g.amt:-g.amt; });
  var absBalance=Math.abs(balance);
  var payoutDue=Math.floor(absBalance/20)*20;
  if (payoutDue<20) return {success:false,message:'No payout due yet. Balance is $'+absBalance.toFixed(2)};

  var covered=0;
  var rowsMarked=[];
  for (var j=0;j<unpaid.length;j++){
    if (covered>=payoutDue) break;
    var g=unpaid[j];
    sheet.getRange(g.rowNum,10).setValue('X');
    sheet.hideRows(g.rowNum);
    covered+=g.amt;
    rowsMarked.push(g.rowNum);
  }

  var owes=balance>0?'Sam':'Matt';
  var owed=balance>0?'Matt':'Sam';
  return {
    success:true,
    payoutAmount:payoutDue,
    gamesMarked:rowsMarked.length,
    owes:owes, owed:owed,
    message:owes+' paid '+owed+' $'+payoutDue+'. '+rowsMarked.length+' games marked paid and hidden.'
  };
}

function markAllPaid() {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var last=sheet.getLastRow(); if (last<2) return;
  var data=sheet.getRange(2,1,last-1,10).getValues(); var n=0;
  for (var i=0;i<data.length;i++){
    if(data[i][7]&&data[i][7]!==''&&data[i][9]!=='X'){sheet.getRange(i+2,10).setValue('X');n++;}
  }
  Logger.log('Marked '+n+' rows as paid.');
}

function autoUpdateScores() {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();
  if (lastRow<2) return {updated:0,pending:0,errors:[]};

  var data=sheet.getRange(2,1,lastRow-1,13).getValues();
  var errors=[],updated=0,pending=0,groups={},summaries={};

  for (var i=0;i<data.length;i++){
    var r=data[i]; if (r[7]||!r[2]) continue; pending++;
    var league=r[1]||'';

    // Use commenceTime (col 11) for date if available, fall back to date column
    var dateStr;
    if (r[10]) {
      try {
        dateStr = Utilities.formatDate(new Date(r[10].toString()), 'America/Chicago', 'yyyyMMdd');
      } catch(e) {
        dateStr = r[0] ? Utilities.formatDate(new Date(r[0]), 'America/Chicago', 'yyyyMMdd') : '';
      }
    } else {
      dateStr = r[0] ? Utilities.formatDate(new Date(r[0]), 'America/Chicago', 'yyyyMMdd') : '';
    }

    // Player props and game bets are graded from the ESPN summary of the game saved with the pick.
    if (/^(PROP|GAME)/.test((r[4]||'').toString())) {
      var g = gradePropRow_(parsePropMeta_(r[12]), parseFloat(r[3]), r[5], summaries);
      if (g && g.error) errors.push('Row ' + (i+2) + ': ' + g.error);
      else if (g) { sheet.getRange(i+2,7,1,3).setValues([[g.scoreStr, g.winner, g.amt]]); updated++; }
      continue;
    }
    var key=league+'|'+dateStr;
    if (!groups[key]) groups[key]={league:league,dateStr:dateStr,rows:[]};
    groups[key].rows.push({rowNum:i+2,game:r[2],line:Math.abs(parseFloat(r[3])||0),odds:r[4]||'',favorite:r[5],commenceTime:r[10]?r[10].toString():''});
  }

  Object.keys(groups).forEach(function(key){
    var grp=groups[key],sportKey=getEspnSportKey(grp.league);
    if (!sportKey) return;
    var isSoccer = (grp.league === 'Premier League' || grp.league === 'Champions League');
    try {
      var groupParam = (grp.league === 'NCAA MBB' || grp.league === 'NCAA WBB') ? '&groups=50' : '';
      
      // For soccer, also search ±1 day to handle timezone differences between CT and event local time
      var datesToSearch = [grp.dateStr];
      if (isSoccer) {
        var d = new Date(grp.dateStr.substring(0,4)+'-'+grp.dateStr.substring(4,6)+'-'+grp.dateStr.substring(6,8)+'T12:00:00Z');
        var prev = new Date(d.getTime() - 86400000);
        var next = new Date(d.getTime() + 86400000);
        var prevStr = Utilities.formatDate(prev, 'UTC', 'yyyyMMdd');
        var nextStr = Utilities.formatDate(next, 'UTC', 'yyyyMMdd');
        datesToSearch.push(prevStr, nextStr);
      }
      
      var allEvents = [];
      for (var di = 0; di < datesToSearch.length; di++) {
        var url = 'https://site.web.api.espn.com/apis/site/v2/sports/' + sportKey + '/scoreboard?dates=' + datesToSearch[di] + '&limit=300' + groupParam;
        var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
        var text = resp.getContentText();
        if (text.charAt(0) === '<') { 
          errors.push(grp.league + ' ' + datesToSearch[di] + ': ESPN returned non-JSON (possible rate limit)');
          continue; 
        }
        var parsed = JSON.parse(text);
        var events = parsed.events || [];
        allEvents = allEvents.concat(events);
        if (datesToSearch.length > 1 && di < datesToSearch.length - 1) Utilities.sleep(500);
      }
      
      // Deduplicate events by ID
      var seenIds = {};
      var uniqueEvents = [];
      for (var ui = 0; ui < allEvents.length; ui++) {
        var evId = allEvents[ui].id || ui;
        if (!seenIds[evId]) { seenIds[evId] = true; uniqueEvents.push(allEvents[ui]); }
      }

      grp.rows.forEach(function(row){
        // ─── O/U TOTAL BET DETECTION ─────────────────────────────────────────
        // Detected by "O/U" prefix in the Odds column (e.g., "O/U -110")
        var isTotal = (row.odds||'').toString().indexOf('O/U') === 0;
        var parts=row.game.split(' vs '); if (parts.length<2) return;
        var favTeam=parts[0].trim(), dogTeam=parts[1].trim();

        for (var ei=0;ei<uniqueEvents.length;ei++){
          var ev=uniqueEvents[ei];
          if (!((ev.status||{}).type||{}).completed) continue;
          var comp=(ev.competitions||[])[0]; if (!comp) continue;
          var comps=comp.competitors||[]; if (comps.length<2) continue;
          var homeC=null,awayC=null;
          for (var ci=0;ci<comps.length;ci++){
            if(comps[ci].homeAway==='home')homeC=comps[ci];else awayC=comps[ci];
          }
          if (!homeC||!awayC) continue;

          var hS=(homeC.team||{}).shortDisplayName||'',aS=(awayC.team||{}).shortDisplayName||'';
          var hF=(homeC.team||{}).displayName||'',aF=(awayC.team||{}).displayName||'';
          var hA=(homeC.team||{}).abbreviation||'',aA=(awayC.team||{}).abbreviation||'';

          var fH, fA2, dH, dA2;
          if (isSoccer) {
            // Use soccer-specific matching for international teams
            fH=soccerTeamsMatch(favTeam,hS)||soccerTeamsMatch(favTeam,hF)||soccerTeamsMatch(favTeam,hA);
            fA2=soccerTeamsMatch(favTeam,aS)||soccerTeamsMatch(favTeam,aF)||soccerTeamsMatch(favTeam,aA);
            dH=soccerTeamsMatch(dogTeam,hS)||soccerTeamsMatch(dogTeam,hF)||soccerTeamsMatch(dogTeam,hA);
            dA2=soccerTeamsMatch(dogTeam,aS)||soccerTeamsMatch(dogTeam,aF)||soccerTeamsMatch(dogTeam,aA);
            // Fallback: try matching against event name (e.g., "Austria vs Jordan")
            if (!((fH&&dA2)||(fA2&&dH))) {
              var evName = (ev.name || '').toLowerCase();
              var favLower = favTeam.toLowerCase(), dogLower = dogTeam.toLowerCase();
              if (evName.indexOf(favLower) >= 0 && evName.indexOf(dogLower) >= 0) {
                // Determine home/away from event name or competitors
                fH = soccerTeamsMatch(favTeam, hF) || soccerTeamsMatch(favTeam, hS) || evName.indexOf(favLower) > evName.indexOf(dogLower);
                fA2 = !fH;
                dH = !fH;
                dA2 = fH;
              }
            }
          } else {
            fH=teamsMatch(favTeam,hS)||teamsMatch(favTeam,hF)||teamsMatch(favTeam,hA);
            fA2=teamsMatch(favTeam,aS)||teamsMatch(favTeam,aF)||teamsMatch(favTeam,aA);
            dH=teamsMatch(dogTeam,hS)||teamsMatch(dogTeam,hF)||teamsMatch(dogTeam,hA);
            dA2=teamsMatch(dogTeam,aS)||teamsMatch(dogTeam,aF)||teamsMatch(dogTeam,aA);
          }
          if (!((fH&&dA2)||(fA2&&dH))) continue;

          // For series games: verify this ESPN event matches our commenceTime
          // This prevents Game 1 result from being applied to Game 2
          if (row.commenceTime && ev.date) {
            var evTime = new Date(ev.date).getTime();
            var rowTime = new Date(row.commenceTime).getTime();
            // Allow up to 4 hour tolerance for soccer (timezone differences + delays)
            var tolerance = isSoccer ? 4 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
            if (Math.abs(evTime - rowTime) > tolerance) continue;
          }

          var hScore=parseInt(homeC.score)||0,aScore=parseInt(awayC.score)||0;
          var favPicker=sheet.getRange(row.rowNum,6).getValue();
          var winner, amt, scoreStr;

          if (isTotal) {
            // ─── O/U TOTAL: compare combined score to the line ─────────────────
            var totalScored = hScore + aScore;
            scoreStr = favTeam + ' ' + (fH?hScore:aScore) + '-' + (fH?aScore:hScore) + ' (Total: ' + totalScored + ')';
            if (totalScored === row.line) {
              winner = 'Split';
              amt = 0;
            } else {
              var overHits = totalScored > row.line;
              // favPicker = whoever picked Over
              winner = overHits ? favPicker : (favPicker==='Matt'?'Sam':'Matt');
              amt = BET_AMOUNT;
            }
          } else {
            // ─── SPREAD: original logic ────────────────────────────────────────
            var favScore=fH?hScore:aScore, dogScore=fH?aScore:hScore;
            var margin = favScore - dogScore;

            // Push detection: margin exactly equals line
            if (margin === row.line) {
              winner = 'Split';
              amt = 0;
            } else {
              var favCovered = margin > row.line;
              winner = favCovered ? favPicker : (favPicker==='Matt'?'Sam':'Matt');
              amt = BET_AMOUNT;
            }

            // Score display: team that covered the spread is listed first
            if (margin === row.line) {
              scoreStr = favTeam + ' ' + favScore + '-' + dogScore;
            } else if (margin > row.line) {
              scoreStr = favTeam + ' ' + favScore + '-' + dogScore;
            } else {
              scoreStr = dogTeam + ' ' + dogScore + '-' + favScore;
            }
          }

          sheet.getRange(row.rowNum,7).setValue(scoreStr);
          sheet.getRange(row.rowNum,8).setValue(winner);
          sheet.getRange(row.rowNum,9).setValue(amt);
          updated++; break;
        }
      });
    } catch(e){errors.push(grp.league+' '+grp.dateStr+': '+e.toString());}
  });

  return {updated:updated,pending:pending,errors:errors};
}

// getLiveScores: fetches only in-progress (state='in') games for today.
function getLiveScores() {
  var sportKeys = [
    'basketball/mens-college-basketball', 'basketball/nba',
    'football/nfl', 'football/college-football',
    'hockey/nhl', 'baseball/mlb', 'golf',
    'soccer/eng.1', 'soccer/uefa.champions'
  ];

  var todayStr = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyyMMdd');
  var liveGames = [];

  sportKeys.forEach(function(sportKey) {
    try {
      var groupParam = (sportKey === 'basketball/mens-college-basketball' || sportKey === 'basketball/womens-college-basketball') ? '&groups=50' : '';
      var url = 'https://site.web.api.espn.com/apis/site/v2/sports/' + sportKey +
        '/scoreboard?limit=300&dates=' + todayStr + groupParam;
      var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
      var text = resp.getContentText();
      if (text.charAt(0) === '<') return;
      var events = JSON.parse(text).events || [];

      events.forEach(function(ev) {
        var status = (ev.status || {}).type || {};
        if (status.state !== 'in') return;

        var eventDateCT = Utilities.formatDate(new Date(ev.date || ''), 'America/Chicago', 'yyyyMMdd');
        if (eventDateCT !== todayStr) return;

        var comp = (ev.competitions || [])[0];
        if (!comp) return;
        var comps = comp.competitors || [];
        if (comps.length < 2) return;

        var homeC = null, awayC = null;
        comps.forEach(function(c) {
          if (c.homeAway === 'home') homeC = c; else awayC = c;
        });
        if (!homeC || !awayC) return;

        var nationalNames = [];
        (comp.broadcasts || []).forEach(function(b) {
          if ((b.market || '').toLowerCase() === 'national') {
            (b.names || []).forEach(function(n) { nationalNames.push(n); });
          }
        });
        (comp.geoBroadcasts || []).forEach(function(b) {
          var mtype = (b.market || {}).type || '';
          if (mtype.toLowerCase() === 'national') {
            var n = (b.media || {}).shortName || '';
            if (n && nationalNames.indexOf(n) < 0) nationalNames.push(n);
          }
        });

        liveGames.push({
          name:        ev.name,
          state:       status.state,
          homeTeam:    (homeC.team || {}).shortDisplayName || '',
          homeDisplay: (homeC.team || {}).displayName || '',
          homeAbbr:    (homeC.team || {}).abbreviation || '',
          awayTeam:    (awayC.team || {}).shortDisplayName || '',
          awayDisplay: (awayC.team || {}).displayName || '',
          awayAbbr:    (awayC.team || {}).abbreviation || '',
          homeScore:   homeC.score || '0',
          awayScore:   awayC.score || '0',
          clock:       ev.status.displayClock || '',
          period:      ev.status.period || 0,
          detail:      status.detail || '',
          tv:          nationalNames.join(' / ')
        });
      });
    } catch(e) {}
  });

  return liveGames;
}

// ─── PLAYER PROPS (ESPN / DraftKings, free, no key) ──────────────────────────
// ESPN's core API exposes DraftKings player props per game (provider 100).
// Rows don't say Over/Under, so each O/U pair is matched to DraftKings'
// one-sided "Milestones" row (e.g. "8+" = Over 7.5): the side priced like the
// milestone is the Over. Pairs that don't match cleanly are skipped.
// Verified 2026-11-23: NBA and NHL have priced props; NFL lines have no prices;
// NCAA F / NCAA MBB have none.
var PROP_BAND = [0.45, 0.55];        // fair (no-vig) Over probability allowed
var PROP_MAX = 10;                   // props shown per game
var PROP_PER_MARKET = 4;             // max per stat type (4 so NHL, with 3 stat types, can still reach 10)
var PROP_CACHE_SEC = 20 * 60;        // cache distilled props per game for 20 min
var ESPN_PROVIDER_DK = 100;
var PROP_MARKETS = {
  // stat: list of components summed; each component lists acceptable box-score
  // labels/keys (first match wins). Labels are checked by testPropGrading().
  'NBA': { sport: 'basketball', league: 'nba', markets: [
    { type: 'Total Points', ms: 'Points Milestones', label: 'Points', stat: [['PTS', 'points']] },
    { type: 'Total Rebounds', ms: 'Rebounds Milestones', label: 'Rebounds', stat: [['REB', 'rebounds', 'totalRebounds']] },
    { type: 'Total Assists', ms: 'Assists Milestones', label: 'Assists', stat: [['AST', 'assists']] },
    { type: 'Total 3-Point Field Goals', ms: '3-Point Field Goals Milestones', label: '3-Pointers',
      stat: [['3PT', '3PM', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointFieldGoalsMade']] },
    { type: 'Total Points, Rebounds, and Assists', ms: 'Points + Assists + Rebounds Milestones', label: 'Pts+Reb+Ast',
      stat: [['PTS', 'points'], ['REB', 'rebounds', 'totalRebounds'], ['AST', 'assists']] }
  ]},
  'NHL': { sport: 'hockey', league: 'nhl', markets: [
    // ESPN hockey: S = shotsTotal (shots on goal; matches team totals). SOG is shootoutGoals: never use it.
    { type: 'Total Shots on Goal', ms: 'Shots on Goal Milestones', label: 'Shots on Goal', stat: [['S', 'shotsTotal']] },
    { type: 'Total Points', ms: 'Points Milestones', label: 'Points', stat: [['G', 'goals'], ['A', 'assists']] },
    { type: 'Total Assists', ms: 'Assists Milestones', label: 'Assists', stat: [['A', 'assists']] },
    // Goalies box score: SV = saves (shootout saves are a separate SOS column).
    { type: 'Total Saves', ms: 'Goalkeeper Saves Milestones', label: 'Goalie Saves', stat: [['SV', 'saves']] }
  ]},
  // MLB (checked on a 2026 postseason game): batting and pitching are separate box-score
  // sections, both with H and K columns, so stats are section-qualified. Total bases is
  // not gradeable (no 2B/3B columns); hits allowed / earned runs didn't pair cleanly.
  'MLB': { sport: 'baseball', league: 'mlb', markets: [
    { type: 'Total Strikeouts', ms: 'Strikeouts Thrown Milestones', label: 'Pitcher Strikeouts', stat: [['pitching.K', 'pitching.strikeouts']] },
    { type: 'Total Hits', ms: 'Hits Milestones', label: 'Hits', stat: [['batting.H', 'batting.hits']] },
    { type: 'Total Hits + Runs + RBIs', ms: 'Hits + Runs + RBIs Milestones', label: 'Hits+Runs+RBIs',
      stat: [['batting.H', 'batting.hits'], ['batting.R', 'batting.runs'], ['batting.RBI', 'batting.RBIs']] }
  ]},
  // NFL: ESPN/DraftKings NFL props had lines but no prices (checked 2026-11-23), so
  // prices come from Kalshi (free public market data). Each Kalshi market is
  // "Player: N+" = Over N-0.5. For each stat the first series with an open event
  // for the game is used. Football box scores split players into sections, each
  // with its own YDS column, so stats are "section.LABEL".
  'NFL': { sport: 'football', league: 'nfl', source: 'kalshi', markets: [
    { series: ['KXNFLPASSYDS', 'KXNFLPASSYDSPROT'], label: 'Passing Yds', stat: [['passing.YDS', 'passing.passingYards']] },
    { series: ['KXNFLPASSTDS', 'KXNFLPASSTDSPROT'], label: 'Passing TDs', stat: [['passing.TD', 'passing.passingTouchdowns']] },
    { series: ['KXNFLRSHYDS', 'KXNFLRSHYDSPROT'], label: 'Rushing Yds', stat: [['rushing.YDS', 'rushing.rushingYards']] },
    { series: ['KXNFLRECYDS', 'KXNFLRECYDSPROT'], label: 'Receiving Yds', stat: [['receiving.YDS', 'receiving.receivingYards']] },
    { series: ['KXNFLREC', 'KXNFLRECPROT', 'KXNFLLADDERREC'], label: 'Receptions', stat: [['receiving.REC', 'receiving.receptions']] }
  ]},
  // NCAA F: no free source has college props (ESPN 0 rows, Kalshi none; checked 2026-11-23), so
  // these come from The Odds API (FanDuel/Bovada). Costs 1 credit per market returned per game
  // opened, so it is guarded by ODDS_API_FLOOR. College box scores use the NFL section labels.
  'NCAA F': { sport: 'football', league: 'college-football', groups: '80', source: 'oddsapi',
              oddsKey: 'americanfootball_ncaaf', markets: [
    { key: 'player_pass_yds', label: 'Passing Yds', stat: [['passing.YDS', 'passing.passingYards']] },
    { key: 'player_rush_yds', label: 'Rushing Yds', stat: [['rushing.YDS', 'rushing.rushingYards']] },
    { key: 'player_reception_yds', label: 'Receiving Yds', stat: [['receiving.YDS', 'receiving.receivingYards']] },
    { key: 'player_receptions', label: 'Receptions', stat: [['receiving.REC', 'receiving.receptions']] }
  ]}
};

// Paid props (Odds API) are switched off while fewer than ODDS_API_FLOOR credits would remain.
var ODDS_API_PROP_CACHE_SEC = 6 * 60 * 60;   // keep paid props 6h so reopening a game costs nothing
var ODDS_API_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'bovada'];  // line source preference

function headerVal_(resp, name) {
  var h = resp.getHeaders(), want = name.toLowerCase();
  for (var k in h) if (k.toLowerCase() === want) return h[k];
  return null;
}

// Pure: Odds API per-event odds -> O/U candidates. Each player+stat takes its line from the
// first book in ODDS_API_BOOKS order that has both sides at a .5 line. Players are keyed by
// name (no ESPN id). Popularity = number of book+stat listings for the player.
function oddsApiPropCandidates_(data, markets) {
  var rank = function(k) { var i = ODDS_API_BOOKS.indexOf(k); return i < 0 ? 99 : i; };
  var books = ((data || {}).bookmakers || []).slice().sort(function(a, b) { return rank(a.key) - rank(b.key); });
  var pop = {};
  books.forEach(function(b) {
    (b.markets || []).forEach(function(m) {
      var seen = {};
      (m.outcomes || []).forEach(function(o) {
        var id = 'name:' + normPlayer_(o.description);
        if (o.description && !seen[id]) { seen[id] = 1; pop[id] = (pop[id] || 0) + 1; }
      });
    });
  });
  var out = [], done = {};
  markets.forEach(function(mk) {
    books.forEach(function(b) {
      var m = (b.markets || []).filter(function(x) { return x.key === mk.key; })[0];
      if (!m) return;
      var pairs = {};
      (m.outcomes || []).forEach(function(o) {
        if (o.description) (pairs[o.description + '|' + o.point] = pairs[o.description + '|' + o.point] || {})[o.name] = o;
      });
      Object.keys(pairs).forEach(function(k) {
        var ov = pairs[k].Over, un = pairs[k].Under;
        if (!ov || !un) return;
        var id = 'name:' + normPlayer_(ov.description), line = Number(ov.point);
        if (done[id + '|' + mk.key] || line % 1 !== 0.5) return;
        done[id + '|' + mk.key] = 1;
        var pO = impliedProb_(ov.price), pU = impliedProb_(un.price);
        out.push({
          athleteId: id, player: ov.description, market: mk.label, stat: mk.stat, line: line,
          overOdds: Number(ov.price), underOdds: Number(un.price),
          impliedOver: pO, impliedUnder: pU, fairOver: pO / (pO + pU),
          updated: m.last_update || '', pop: pop[id] || 0, book: b.title || b.key
        });
      });
    });
  });
  return out;
}

function getOddsApiProps_(cfg, homeTeam, awayTeam, commenceTime) {
  var base = 'https://api.the-odds-api.com/v4/sports/' + cfg.oddsKey;
  var key = encodeURIComponent(oddsApiKey_());
  // /events costs nothing and its headers report credits left: check the budget before spending.
  var r = UrlFetchApp.fetch(base + '/events?apiKey=' + key, { muteHttpExceptions: true });
  noteOddsApiCredits_(r);
  if (r.getResponseCode() !== 200) return { cands: [], reason: 'Player props unavailable right now' };
  var left = Number(headerVal_(r, 'x-requests-remaining'));
  if (isNaN(left) || left - cfg.markets.length < ODDS_API_FLOOR) {
    return { cands: [], paused: true,
             reason: 'College props paused: Odds API credits are low (' + (isNaN(left) ? '?' : left) +
                     ' left). Regular odds still work.' };
  }
  var start = new Date(commenceTime).getTime();
  var oe = (JSON.parse(r.getContentText()) || []).filter(function(e) {
    return teamsMatch(e.home_team, homeTeam) && teamsMatch(e.away_team, awayTeam) &&
           Math.abs(new Date(e.commence_time).getTime() - start) <= 2 * 60 * 60 * 1000;
  })[0];
  if (!oe) return { cands: [], reason: 'No player props posted for this game yet' };
  var r2 = UrlFetchApp.fetch(base + '/events/' + oe.id + '/odds?apiKey=' + key + '&regions=us&oddsFormat=american' +
                             '&markets=' + cfg.markets.map(function(m) { return m.key; }).join(','),
                             { muteHttpExceptions: true });
  noteOddsApiCredits_(r2);
  if (r2.getResponseCode() !== 200) return { cands: [], reason: 'Player props unavailable right now' };
  var cands = oddsApiPropCandidates_(JSON.parse(r2.getContentText()), cfg.markets);
  return { cands: cands, reason: cands.length ? '' : 'No player props posted for this game yet' };
}

// Odds API props have names but no teams: look the kept players up on the two ESPN rosters.
function rosterTeams_(cfg, ev) {
  var ids = Object.keys(ev.teams), map = {};
  var resps = UrlFetchApp.fetchAll(ids.map(function(id) {
    return { url: 'https://site.web.api.espn.com/apis/site/v2/sports/' + cfg.sport + '/' + cfg.league +
                  '/teams/' + id + '/roster', muteHttpExceptions: true };
  }));
  resps.forEach(function(r, i) {
    var j = {};
    try { j = JSON.parse(r.getContentText()); } catch (e) {}
    (j.athletes || []).forEach(function(g) {
      (g.items || []).forEach(function(a) { map['name:' + normPlayer_(a.displayName)] = ev.teams[ids[i]]; });
    });
  });
  return map;
}

var KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
var KALSHI_MAX_SPREAD = 0.04;   // skip markets whose bid/ask gap is wider than 4 cents (price not reliable)

// "Ja'Marr Chase Jr." -> "jamarrchase": used to match Kalshi names to ESPN box scores.
function normPlayer_(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, '');
}

function probToAmerican_(p) {
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

// Pure: Kalshi "Player: N+" markets -> O/U candidates. Over = buy Yes at the ask,
// Under = buy No at (1 - bid); fair Over = mid price.
function kalshiPropCandidates_(kms, mk) {
  var out = [];
  // Popularity: total contracts traded across all of a player's markets in this stat.
  var vol = {};
  (kms || []).forEach(function(m) {
    var n = String(m.yes_sub_title || '').split(':')[0].trim();
    vol[n] = (vol[n] || 0) + (parseFloat(m.volume_fp) || 0);
  });
  (kms || []).forEach(function(m) {
    if (m.status && m.status !== 'active') return;
    if (m.strike_type && m.strike_type !== 'greater') return;
    var line = Number(m.floor_strike);
    if (isNaN(line) || line % 1 !== 0.5) return;
    var bid = parseFloat(m.yes_bid_dollars), ask = parseFloat(m.yes_ask_dollars);
    if (!(bid > 0 && ask < 1 && ask >= bid) || ask - bid > KALSHI_MAX_SPREAD) return;
    var name = String(m.yes_sub_title || '').split(':')[0].trim();
    if (!name) return;
    out.push({
      athleteId: 'name:' + normPlayer_(name), player: name, kalshiSeg: String(m.ticker || '').split('-')[2] || '',
      market: mk.label, stat: mk.stat, line: line,
      overOdds: probToAmerican_(ask), underOdds: probToAmerican_(1 - bid),
      impliedOver: ask, impliedUnder: 1 - bid, fairOver: (bid + ask) / 2,
      updated: m.updated_time || '', pop: vol[name] || 0
    });
  });
  return out;
}

// Pure: team for a Kalshi market segment like "WASSDIGGS3", given the event's
// Kalshi codes ["CIN","WAS"] and ESPN abbreviations ["CIN","WSH"].
function kalshiTeam_(seg, kalshiCodes, espnAbbrs) {
  var code = kalshiCodes.filter(function(c) { return seg.indexOf(c) === 0; })[0];
  if (!code) return '';
  if (espnAbbrs.indexOf(code) >= 0) return code;
  return espnAbbrs.filter(function(a) { return kalshiCodes.indexOf(a) < 0; })[0] || code;
}

function kalshiParse_(r) { try { return JSON.parse(r.getContentText()); } catch (e) { return {}; } }

// The open Kalshi event for this game in each series (event ticker has the game date, e.g.
// "-26NOV23CINWAS", and the title names both teams). Returns { series: event }.
function kalshiEventsFor_(series, homeTeam, awayTeam, commenceTime) {
  var dateCode = '-' + Utilities.formatDate(new Date(commenceTime), 'America/New_York', 'yyMMMdd').toUpperCase();
  var resps = UrlFetchApp.fetchAll(series.map(function(s) {
    return { url: KALSHI_API + '/events?series_ticker=' + s + '&status=open&limit=100', muteHttpExceptions: true };
  }));
  var eventFor = {};
  resps.forEach(function(r, i) {
    (kalshiParse_(r).events || []).forEach(function(e) {
      if (eventFor[series[i]] || String(e.event_ticker).indexOf(dateCode) < 0) return;
      var t = String(e.title || '').split(':')[0].split(' vs ');
      if (t.length !== 2) return;
      if ((teamsMatch(t[0], awayTeam) && teamsMatch(t[1], homeTeam)) ||
          (teamsMatch(t[0], homeTeam) && teamsMatch(t[1], awayTeam))) eventFor[series[i]] = e;
    });
  });
  return eventFor;
}

function getKalshiProps_(cfg, ev, homeTeam, awayTeam, commenceTime) {
  var all = [];
  cfg.markets.forEach(function(mk) { mk.series.forEach(function(s) { all.push(s); }); });
  var parse = kalshiParse_;
  var eventFor = kalshiEventsFor_(all, homeTeam, awayTeam, commenceTime);
  var chosen = [];
  cfg.markets.forEach(function(mk) {
    var s = mk.series.filter(function(x) { return eventFor[x]; })[0];
    if (s) chosen.push({ mk: mk, ev: eventFor[s] });
  });
  if (!chosen.length) return { cands: [], found: false };
  var mResps = UrlFetchApp.fetchAll(chosen.map(function(c) {
    return { url: KALSHI_API + '/markets?event_ticker=' + c.ev.event_ticker + '&limit=1000', muteHttpExceptions: true };
  }));
  var espnAbbrs = Object.keys(ev.teams).map(function(k) { return ev.teams[k]; });
  var cands = [];
  chosen.forEach(function(c, i) {
    var codes = (String(c.ev.sub_title || '').match(/^([A-Z]+) vs ([A-Z]+)/) || []).slice(1);
    kalshiPropCandidates_(parse(mResps[i]).markets, c.mk).forEach(function(p) {
      p.team = kalshiTeam_(p.kalshiSeg, codes, espnAbbrs);
      p.opp = p.team ? (espnAbbrs.filter(function(a) { return a !== p.team; })[0] || '') : '';
      cands.push(p);
    });
  });
  return { cands: cands, found: true };
}

function impliedProb_(american) {
  var a = Number(american);
  return a < 0 ? -a / (-a + 100) : 100 / (a + 100);
}

function espnJson_(url) {
  var r = UrlFetchApp.fetch(url.replace('http://', 'https://'), { muteHttpExceptions: true });
  var t = r.getContentText();
  if (r.getResponseCode() !== 200 || t.charAt(0) !== '{') return null;
  return JSON.parse(t);
}

// Find the ESPN event for an Odds API game (team names + start time within 2h).
function findEspnEvent_(cfg, homeTeam, awayTeam, commenceTime) {
  var start = new Date(commenceTime);
  var dateStr = Utilities.formatDate(start, 'America/Chicago', 'yyyyMMdd');
  var sb = espnJson_('https://site.web.api.espn.com/apis/site/v2/sports/' + cfg.sport + '/' + cfg.league +
                     '/scoreboard?dates=' + dateStr + '&limit=300' + (cfg.groups ? '&groups=' + cfg.groups : ''));
  var events = (sb && sb.events) || [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i], comp = (ev.competitions || [])[0] || {}, home = null, away = null;
    (comp.competitors || []).forEach(function(c) { if (c.homeAway === 'home') home = c; else away = c; });
    if (!home || !away) continue;
    var hm = teamsMatch(homeTeam, (home.team || {}).displayName) || teamsMatch(homeTeam, (home.team || {}).shortDisplayName);
    var aw = teamsMatch(awayTeam, (away.team || {}).displayName) || teamsMatch(awayTeam, (away.team || {}).shortDisplayName);
    if (!hm || !aw) continue;
    if (Math.abs(new Date(ev.date).getTime() - start.getTime()) > 2 * 60 * 60 * 1000) continue;
    var teams = {};
    teams[(home.team || {}).id] = (home.team || {}).abbreviation;
    teams[(away.team || {}).id] = (away.team || {}).abbreviation;
    return { id: ev.id, teams: teams, homeId: String((home.team || {}).id), awayId: String((away.team || {}).id) };
  }
  return null;
}

function fetchPropRows_(cfg, eventId) {
  var items = [], page = 1, pages = 1;
  do {
    var j = espnJson_('https://sports.core.api.espn.com/v2/sports/' + cfg.sport + '/leagues/' + cfg.league +
                      '/events/' + eventId + '/competitions/' + eventId + '/odds/' + ESPN_PROVIDER_DK +
                      '/propBets?limit=1000&page=' + page);
    if (!j) break;
    items = items.concat(j.items || []);
    pages = j.pageCount || 1;
    page++;
  } while (page <= pages);
  return items;
}

// Pure: turn ESPN prop rows into priced O/U candidates with a known Over side.
function buildPropCandidates_(items, markets) {
  var athId = function(it) { return it.athlete && it.athlete.$ref ? ((it.athlete.$ref.match(/athletes\/(\d+)/) || [])[1] || null) : null; };
  var price = function(it) { return it.odds && it.odds.american ? Number(it.odds.american.value) : NaN; };
  var target = function(it) { return it.current && it.current.target ? Number(it.current.target.value) : NaN; };
  // Popularity: DraftKings posts many more props (every stat, long milestone ladders)
  // for stars than for bench players, so the row count per player is a good proxy.
  var pop = {};
  items.forEach(function(it) { var id = athId(it); if (id) pop[id] = (pop[id] || 0) + 1; });
  var out = [];
  markets.forEach(function(mk) {
    var groups = {}, miles = {};
    items.forEach(function(it) {
      var tn = (it.type || {}).name, id = athId(it);
      if (!id || isNaN(price(it)) || isNaN(target(it))) return;
      if (tn === mk.type) { var k = id + '|' + target(it); (groups[k] = groups[k] || []).push(it); }
      else if (tn === mk.ms) { var mkey = id + '|' + target(it); miles[mkey] = miles[mkey] || it; }
    });
    Object.keys(groups).forEach(function(k) {
      var g = groups[k];
      if (g.length !== 2) return;
      var line = target(g[0]);
      if (line % 1 !== 0.5) return;                           // .5 lines only: no pushes
      var m = miles[athId(g[0]) + '|' + (line + 0.5)];          // "N+" milestone == Over (N - 0.5)
      if (!m) return;
      var pm = impliedProb_(price(m));
      var d0 = Math.abs(impliedProb_(price(g[0])) - pm), d1 = Math.abs(impliedProb_(price(g[1])) - pm);
      var lo = Math.min(d0, d1), hi = Math.max(d0, d1);
      if (lo > 0.03 || hi - lo < 0.02) return;                  // not a clean match: skip, never guess
      var over = d0 < d1 ? g[0] : g[1], under = d0 < d1 ? g[1] : g[0];
      var pO = impliedProb_(price(over)), pU = impliedProb_(price(under));
      out.push({
        athleteId: athId(over), market: mk.label, marketType: mk.type, stat: mk.stat, line: line,
        overOdds: price(over), underOdds: price(under),
        impliedOver: pO, impliedUnder: pU, fairOver: pO / (pO + pU),
        updated: over.lastUpdated || '', pop: pop[athId(over)] || 0
      });
    });
  });
  return out;
}

// Pure: keep only 45-55% fair (every pick is a fair bet), then most popular players
// first (ties: closest to 50%), 1 per player, max PROP_PER_MARKET per stat type.
function selectProps_(cands) {
  var pool = cands.filter(function(c) { return c.fairOver >= PROP_BAND[0] && c.fairOver <= PROP_BAND[1]; })
    .sort(function(a, b) {
      return ((b.pop || 0) - (a.pop || 0)) || (Math.abs(a.fairOver - 0.5) - Math.abs(b.fairOver - 0.5));
    });
  var out = [], byPlayer = {}, byMarket = {};
  for (var i = 0; i < pool.length && out.length < PROP_MAX; i++) {
    var c = pool[i];
    if (byPlayer[c.athleteId] || (byMarket[c.market] || 0) >= PROP_PER_MARKET) continue;
    byPlayer[c.athleteId] = 1; byMarket[c.market] = (byMarket[c.market] || 0) + 1;
    out.push(c);
  }
  return out;
}

function getPlayerProps(league, homeTeam, awayTeam, commenceTime) {
  var cfg = PROP_MARKETS[league];
  if (!cfg) return { props: [], reason: 'Player props are not available for ' + league };
  if (!isPickOpen_(commenceTime)) return { props: [], reason: 'Picks are locked for this game' };
  var cache = CacheService.getScriptCache();
  var key = 'props_v1_' + Utilities.base64EncodeWebSafe(league + '|' + homeTeam + '|' + awayTeam + '|' + commenceTime);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  try {
    var ev = findEspnEvent_(cfg, homeTeam, awayTeam, commenceTime);
    if (!ev) return { props: [], reason: 'Could not find this game on ESPN' };
    if (cfg.source === 'kalshi') {
      var k = getKalshiProps_(cfg, ev, homeTeam, awayTeam, commenceTime);
      var kp = selectProps_(k.cands);
      kp.forEach(function(p) { p.eventId = ev.id; p.sport = cfg.sport; p.espnLeague = cfg.league; p.book = 'Kalshi'; });
      var kout = { props: kp, fetchedAt: new Date().toISOString(),
                   reason: kp.length ? '' : !k.found ? 'No Kalshi player markets for this game yet'
                         : 'No player props close to 50/50 for this game' };
      try { cache.put(key, JSON.stringify(kout), PROP_CACHE_SEC); } catch (e) {}
      return kout;
    }
    if (cfg.source === 'oddsapi') {
      var o = getOddsApiProps_(cfg, homeTeam, awayTeam, commenceTime);
      var op = selectProps_(o.cands);
      var teamOf = op.length ? rosterTeams_(cfg, ev) : {};
      var abbrs = Object.keys(ev.teams).map(function(k) { return ev.teams[k]; });
      op.forEach(function(p) {
        p.team = teamOf[p.athleteId] || '';
        p.opp = p.team ? (abbrs.filter(function(a) { return a !== p.team; })[0] || '') : '';
        p.eventId = ev.id; p.sport = cfg.sport; p.espnLeague = cfg.league;
      });
      var oout = { props: op, fetchedAt: new Date().toISOString(),
                   reason: op.length ? '' : o.reason || 'No player props close to 50/50 for this game' };
      // Paid lookups that found props are kept 6h; empty/paused results are retried after 20 min.
      try { cache.put(key, JSON.stringify(oout), o.cands.length ? ODDS_API_PROP_CACHE_SEC : PROP_CACHE_SEC); } catch (e) {}
      return oout;
    }
    var rows = fetchPropRows_(cfg, ev.id);
    var picks = selectProps_(buildPropCandidates_(rows, cfg.markets));
    var priced = rows.some(function(it) { return it.odds && it.odds.american; });
    // Names + teams for the few props we keep (one small request each, in parallel).
    var resps = picks.length ? UrlFetchApp.fetchAll(picks.map(function(p) {
      return { url: 'https://sports.core.api.espn.com/v2/sports/' + cfg.sport + '/leagues/' + cfg.league +
                    '/athletes/' + p.athleteId, muteHttpExceptions: true };
    })) : [];
    var teamIds = Object.keys(ev.teams);
    picks.forEach(function(p, i) {
      var a = {};
      try { a = JSON.parse(resps[i].getContentText()); } catch (e) {}
      var tid = (((a.team || {}).$ref || '').match(/teams\/(\d+)/) || [])[1];
      p.player = a.displayName || a.fullName || ('Player ' + p.athleteId);
      p.team = ev.teams[tid] || '';
      p.opp = p.team ? ev.teams[teamIds[0] === tid ? teamIds[1] : teamIds[0]] : '';
      p.eventId = ev.id; p.sport = cfg.sport; p.espnLeague = cfg.league; p.book = 'DraftKings';
    });
    var out = { props: picks, fetchedAt: new Date().toISOString(),
                reason: picks.length ? '' : !rows.length ? 'No player props posted for this game yet'
                      : !priced ? 'Player prop prices not posted for this game yet'
                      : 'No player props close to 50/50 for this game' };
    try { cache.put(key, JSON.stringify(out), PROP_CACHE_SEC); } catch (e) {}
    return out;
  } catch (e) {
    return { props: [], reason: 'Player props unavailable right now' };
  }
}

// ESPN box score for one game (live or final).
function getEspnSummary_(sport, league, eventId) {
  return espnJson_('https://site.web.api.espn.com/apis/site/v2/sports/' + sport + '/' + league + '/summary?event=' + eventId);
}

function summaryStatus_(summary) {
  var st = ((((summary || {}).header || {}).competitions || [])[0] || {}).status || {};
  var t = st.type || {};
  return { state: t.state || '', completed: !!t.completed, detail: t.shortDetail || t.detail || '' };
}

// Pure: a player's stat from an ESPN summary.
//   {played:true, value}  stat found
//   {played:false}        player listed as did-not-play, or (basketball/hockey) absent from a box score that exists
//   null                  can't tell: no box score, missing column, or a football player absent from every
//                         section (football lists only players with stats) -> caller leaves the bet pending
// Stat names may be "section.LABEL" (football): a player who appears in other sections but not this one
// had none of that stat, so it counts as 0.
function findAthleteStat_(summary, athleteId, stat) {
  var teams = (((summary || {}).boxscore || {}).players) || [];
  if (!teams.length) return null;
  var entries = [];
  // Kalshi props carry no ESPN id, so they are keyed "name:<normalized name>".
  var byName = String(athleteId).indexOf('name:') === 0 ? String(athleteId).slice(5) : null;
  teams.forEach(function(t) {
    (t.statistics || []).forEach(function(grp) {
      (grp.athletes || []).forEach(function(a) {
        if (byName ? normPlayer_((a.athlete || {}).displayName) !== byName
                   : String((a.athlete || {}).id) !== String(athleteId)) return;
        // Section name: football uses grp.name ("passing"); baseball uses grp.type ("batting"/"pitching").
        entries.push({ name: grp.name || grp.type || '', labels: (grp.labels || []).map(String),
                       keys: (grp.keys || grp.names || []).map(String), stats: a.stats || [],
                       dnp: !!a.didNotPlay || !(a.stats || []).length });
      });
    });
  });
  var sectioned = stat.some(function(alts) { return alts.some(function(x) { return x.indexOf('.') > 0; }); });
  if (!entries.length) return sectioned ? null : { played: false };
  var live = entries.filter(function(e) { return !e.dnp; });
  if (!live.length) return { played: false };
  var total = 0;
  for (var c = 0; c < stat.length; c++) {
    var v = NaN, sectionAbsent = false;
    for (var i = 0; i < stat[c].length && isNaN(v); i++) {
      var alt = stat[c][i], dot = alt.indexOf('.');
      var sec = dot > 0 ? alt.slice(0, dot) : null, col = dot > 0 ? alt.slice(dot + 1) : alt;
      var pool = sec ? live.filter(function(e) { return e.name === sec; }) : live;
      if (sec && !pool.length) { sectionAbsent = true; continue; }
      for (var j = 0; j < pool.length && isNaN(v); j++) {
        var idx = pool[j].labels.indexOf(col); if (idx < 0) idx = pool[j].keys.indexOf(col);
        // parseFloat reads the leading number: "3-7" -> 3 (made), "22/31" -> 22, "-3" -> -3 (negative yards).
        if (idx >= 0) v = parseFloat(String(pool[j].stats[idx]));
      }
    }
    if (isNaN(v) && sectionAbsent) v = 0;   // played, but none of this stat
    if (isNaN(v)) return null;              // column not found: never guess
    total += v;
  }
  return { played: true, value: total };
}

// Live stat lines for pending prop rows (rows = "12,15"). Used by the home tab.
function getLivePropStats(rows) {
  var list = String(rows || '').split(',').map(function(s) { return parseInt(s, 10); })
    .filter(function(n) { return n >= 2; }).slice(0, 30);
  if (!list.length) return {};
  var cache = CacheService.getScriptCache(), ck = 'liveprops_' + list.join('_');
  var hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var out = {}, summaries = {};
  list.forEach(function(r) {
    var meta = null;
    try { meta = JSON.parse(sheet.getRange(r, 13).getValue() || 'null'); } catch (e) {}
    if (!meta || !meta.eventId) return;
    var sk = meta.sport + '/' + meta.espnLeague + '/' + meta.eventId;
    if (!(sk in summaries)) summaries[sk] = getEspnSummary_(meta.sport, meta.espnLeague, meta.eventId);
    var s = summaries[sk]; if (!s) return;
    if (meta.kind === 'game') { out[r] = liveGameBet_(meta, s); return; }
    var st = summaryStatus_(s), v = findAthleteStat_(s, meta.athleteId, meta.stat);
    out[r] = { state: st.state, detail: st.detail, played: v ? v.played : null, value: v && v.played ? v.value : null };
  });
  try { cache.put(ck, JSON.stringify(out), 20); } catch (e) {}
  return out;
}

// Grade one prop row from its stored snapshot. Returns null to leave it pending.
function gradePropRow_(meta, line, favPicker, summaries) {
  if (!meta || !meta.eventId) return { error: 'prop row has no ESPN game id' };
  var sk = meta.sport + '/' + meta.espnLeague + '/' + meta.eventId;
  if (!(sk in summaries)) summaries[sk] = getEspnSummary_(meta.sport, meta.espnLeague, meta.eventId);
  var s = summaries[sk];
  if (!s || !summaryStatus_(s).completed) return null;
  if (meta.kind === 'game') return gradeGameBet_(meta, line, favPicker, s);
  var v = findAthleteStat_(s, meta.athleteId, meta.stat);
  if (!v) return { error: meta.player + ' ' + meta.market + ': stat not in the ESPN box score (player may not have recorded one) - grade by hand' };
  var label = meta.player + ' ' + meta.market;
  if (!v.played) return { scoreStr: label + ': VOID (did not play)', winner: 'Split', amt: 0 };
  if (v.value === line) return { scoreStr: label + ': ' + v.value + ' (push)', winner: 'Split', amt: 0 };
  var overHit = v.value > line;
  return { scoreStr: label + ': ' + v.value + ' (' + (overHit ? 'Over' : 'Under') + ' ' + line + ')',
           winner: overHit ? favPicker : (favPicker === 'Matt' ? 'Sam' : 'Matt'), amt: BET_AMOUNT };
}

// ─── GAME BETS: halves / quarters / periods / first 5 innings + team totals ──
// Free, from the same ESPN/DraftKings feed as player props; only 45-55% bets are shown.
// Spread and moneyline rows name their team. Total rows don't say which side is Over, so a
// total is offered only when its two prices are close enough that EITHER side is 45-55%
// (the band is symmetric, so one check covers both). Graded from ESPN period scores.
// periods: [first, last]; last null = through the end of the game (includes OT / extra innings).
var GAME_BETS = {
  'NBA': { segs: [
    { name: '1st Half', periods: [1, 2], spread: '1st Half Spread', ml: '1st Half Moneyline', total: '1st Half Total' },
    { name: '2nd Half (incl. OT)', periods: [3, null], spread: '2nd Half Spread', ml: '2nd Half Moneyline', total: '2nd Half Total' },
    { name: '1st Quarter', periods: [1, 1], spread: '1st Quarter Spread', ml: '1st Quarter Moneyline', total: '1st Quarter Total' },
    { name: '2nd Quarter', periods: [2, 2], spread: '2nd Quarter Spread', ml: '2nd Quarter Moneyline', total: '2nd Quarter Total' },
    { name: '3rd Quarter', periods: [3, 3], spread: '3rd Quarter Spread', ml: '3rd Quarter Moneyline', total: '3rd Quarter Total' },
    { name: '4th Quarter (no OT)', periods: [4, 4], spread: '4th Quarter Spread', ml: '4th Quarter Moneyline', total: '4th Quarter Total' }
  ], team: [
    { name: 'Team Total (incl. OT)', type: 'Team Total Points', periods: [1, null] },
    { name: 'Team 1st Half Total', type: 'Team 1st Half Total Points', periods: [1, 2] }
  ]},
  // Period moneylines are 3-way (a tied period is its own outcome), so only spreads and totals.
  'NHL': { segs: [
    { name: '1st Period', periods: [1, 1], spread: '1st Period Spread', total: '1st Period Total Goals' },
    { name: '2nd Period', periods: [2, 2], spread: '2nd Period Spread', total: '2nd Period Total Goals' },
    { name: '3rd Period (no OT)', periods: [3, 3], spread: '3rd Period Spread', total: '3rd Period Total Goals' }
  ], team: [
    { name: 'Team Total (no OT)', type: 'Team Total Goals (Excl OT)', periods: [1, 3] }
  ]},
  'MLB': { segs: [
    { name: 'First 5 Innings', periods: [1, 5], spread: '1st 5 Innings Run Line', ml: '1st 5 Innings Moneyline', total: '1st 5 Innings Total Runs' }
  ], team: [
    { name: 'Team Total (incl. extras)', type: 'Team Total Runs', periods: [1, null] }
  ]},
  // NFL: ESPN lists these lines with no prices (checked 2026-11-23), so they come from Kalshi
  // (free). Values are Kalshi series of yes/no contracts: totals "Over X points", spreads
  // "Cincinnati wins by over X points", team totals "Cincinnati over X points". Kalshi rules
  // (checked 2026-11-23): 2nd half includes OT, 4th quarter excludes OT, team total = full game.
  // Half/quarter winner series had no open games, so there are no NFL segment moneylines.
  'NFL': { source: 'kalshi', segs: [
    { name: '1st Half', periods: [1, 2], spread: 'KXNFL1HSPREAD', total: 'KXNFL1HTOTAL' },
    { name: '2nd Half (incl. OT)', periods: [3, null], spread: 'KXNFL2HSPREAD', total: 'KXNFL2HTOTAL' },
    { name: '1st Quarter', periods: [1, 1], spread: 'KXNFL1QSPREAD', total: 'KXNFL1QTOTAL' },
    { name: '2nd Quarter', periods: [2, 2], spread: 'KXNFL2QSPREAD', total: 'KXNFL2QTOTAL' },
    { name: '3rd Quarter', periods: [3, 3], spread: 'KXNFL3QSPREAD', total: 'KXNFL3QTOTAL' },
    { name: '4th Quarter (no OT)', periods: [4, 4], spread: 'KXNFL4QSPREAD', total: 'KXNFL4QTOTAL' }
  ], team: [
    { name: 'Team Total (incl. OT)', series: 'KXNFLTEAMTOTAL', periods: [1, null] },
    { name: 'Team 1st Half Total', series: 'KXNFL1HTEAMTOTAL', periods: [1, 2] }
  ]}
};

// Pure: the Kalshi "over X" contract closest to 50% among those that are 45-55% (mid price),
// on a .5 line, with a tight bid/ask. Over = buy Yes at the ask; Under = buy No at (1 - bid).
function kalshiOverPick_(markets, keep) {
  var best = null;
  (markets || []).forEach(function(m) {
    if ((m.status && m.status !== 'active') || (m.strike_type && m.strike_type !== 'greater')) return;
    if (keep && !keep(m)) return;
    var line = Number(m.floor_strike);
    if (isNaN(line) || line % 1 !== 0.5) return;
    var bid = parseFloat(m.yes_bid_dollars), ask = parseFloat(m.yes_ask_dollars);
    if (!(bid > 0 && ask < 1 && ask >= bid) || ask - bid > KALSHI_MAX_SPREAD) return;
    var mid = (bid + ask) / 2;
    if (mid < PROP_BAND[0] || mid > PROP_BAND[1]) return;
    if (!best || Math.abs(mid - 0.5) < Math.abs(best.mid - 0.5)) {
      best = { line: line, bid: bid, ask: ask, mid: mid, updated: m.updated_time || '' };
    }
  });
  return best;
}

// Pure: Kalshi markets for one game (keyed by series) -> { periods, team } game bets.
// Team-total markets read "Cincinnati over 14.5 points"; Kalshi's team name is a prefix of
// ESPN's ("Los Angeles R" -> "Los Angeles Rams"), which also keeps NYG/NYJ apart.
function buildKalshiGameBets_(cfg, bySeries, ev, homeTeam, awayTeam) {
  var out = { periods: [], team: [] };
  var bet = function(seg, betType, p, x) {
    return Object.assign({ kind: 'game', segment: seg.name, periods: seg.periods, betType: betType, player: seg.name,
      team: '', opp: '', book: 'Kalshi', line: p.line, fairOver: p.mid, fairKnown: true,
      overOdds: probToAmerican_(p.ask), underOdds: probToAmerican_(1 - p.bid),
      impliedOver: p.ask, impliedUnder: 1 - p.bid, updated: p.updated }, x);
  };
  var norm = function(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var isTeam = function(m, splitRe, team) {
    var who = norm(String(m.yes_sub_title || '').split(splitRe)[0]);
    return who && norm(team).indexOf(who) === 0;
  };
  var sides = [[homeTeam, ev.homeId, true], [awayTeam, ev.awayId, false]];
  cfg.segs.forEach(function(seg) {
    // Spread: each team has its own "wins by over X" ladder. Yes = that team -X (side A),
    // No = the other team +X. Keep the single contract closest to 50% across both ladders.
    if (seg.spread) {
      var best = null;
      sides.forEach(function(t) {
        var p = kalshiOverPick_(bySeries[seg.spread], function(m) { return isTeam(m, / wins by over /i, t[0]); });
        if (p && (!best || Math.abs(p.mid - 0.5) < Math.abs(best.p.mid - 0.5))) best = { p: p, t: t };
      });
      if (best) {
        var a = ev.teams[best.t[1]] || '', b = ev.teams[(best.t[2] ? ev.awayId : ev.homeId)] || '';
        out.periods.push(bet(seg, 'spread', best.p, { line: -best.p.line, market: 'Spread ' + a + ' -' + best.p.line,
          sideHome: best.t[2], sideA: a + ' -' + best.p.line, sideB: b + ' +' + best.p.line }));
      }
    }
    var p = seg.total && kalshiOverPick_(bySeries[seg.total]);
    if (p) out.periods.push(bet(seg, 'total', p, { market: 'Total ' + p.line, sideA: 'Over ' + p.line, sideB: 'Under ' + p.line }));
  });
  (cfg.team || []).forEach(function(tt) {
    sides.forEach(function(t) {
      var ab = ev.teams[t[1]] || '';
      var p = kalshiOverPick_(bySeries[tt.series], function(m) { return isTeam(m, / over /i, t[0]); });
      if (p) out.team.push(bet(tt, 'teamTotal', p, { market: ab + ' Total ' + p.line, sideHome: t[2],
        sideA: ab + ' Over ' + p.line, sideB: ab + ' Under ' + p.line }));
    });
  });
  return out;
}

function signedLine_(n) { return n > 0 ? '+' + n : String(n); }

// Pure: ESPN propBets rows (no athlete) -> { periods: [...], team: [...] } of 45-55% game bets.
// Side A is the side whoever is in column F takes: the favorite (spread/ML) or the Over (totals).
// One bet per segment and bet type: the line closest to 50%.
function buildGameBets_(items, cfg, ev) {
  var tid = function(it) { return it.team && it.team.$ref ? ((it.team.$ref.match(/teams\/(\d+)/) || [])[1] || null) : null; };
  var price = function(it) { return it.odds && it.odds.american ? Number(it.odds.american.value) : NaN; };
  var target = function(it) { return it.current && it.current.target ? Number(it.current.target.value) : NaN; };
  var fair2 = function(a, b) { var pa = impliedProb_(a), pb = impliedProb_(b); return pa / (pa + pb); };
  var inBand = function(f) { return f >= PROP_BAND[0] && f <= PROP_BAND[1]; };
  var abbr = function(id) { return ev.teams[id] || ''; };
  var best = function(list) {
    return list.sort(function(x, y) { return Math.abs(x.fairOver - 0.5) - Math.abs(y.fairOver - 0.5); })[0];
  };
  var byType = {};
  (items || []).forEach(function(it) {
    var n = (it.type || {}).name;
    if (it.athlete || !n || isNaN(price(it))) return;
    (byType[n] = byType[n] || []).push(it);
  });
  var make = function(seg, betType, A, B, f, x) {
    return Object.assign({ kind: 'game', segment: seg.name, periods: seg.periods, betType: betType, player: seg.name,
      team: '', opp: '', book: 'DraftKings', fairOver: f, updated: (A && A.lastUpdated) || '' }, x);
  };
  var totals = function(seg, rows, betType, extra) {   // rows: the 2-row O/U pairs for one total
    var byLine = {}, list = [];
    rows.forEach(function(it) { var t = target(it); if (!isNaN(t)) (byLine[t] = byLine[t] || []).push(it); });
    Object.keys(byLine).forEach(function(t) {
      var g = byLine[t]; if (g.length !== 2) return;
      var f = fair2(price(g[0]), price(g[1])); if (!inBand(f)) return;
      var line = Number(t);
      list.push(make(seg, betType, g[0], g[1], f, Object.assign({ line: line, sideA: 'Over ' + line, sideB: 'Under ' + line,
        overOdds: null, underOdds: null, prices: [price(g[0]), price(g[1])], fairKnown: false }, extra(line))));
    });
    return best(list);
  };
  var out = { periods: [], team: [] };
  cfg.segs.forEach(function(seg) {
    // Spread: one row per team, opposite signs.
    var lines = {}, sp = [];
    (byType[seg.spread] || []).forEach(function(it) {
      var id = tid(it), t = target(it); if (!id || isNaN(t)) return;
      (lines[Math.abs(t)] = lines[Math.abs(t)] || {})[id] = it;
    });
    Object.keys(lines).forEach(function(k) {
      var h = lines[k][ev.homeId], a = lines[k][ev.awayId];
      if (!h || !a || target(h) + target(a) !== 0) return;
      var A = target(h) <= 0 ? h : a, B = A === h ? a : h;
      var f = fair2(price(A), price(B)); if (!inBand(f)) return;
      var la = target(A), sa = abbr(tid(A)), sb = abbr(tid(B));
      sp.push(make(seg, 'spread', A, B, f, { market: 'Spread ' + sa + ' ' + signedLine_(la), line: la,
        sideA: sa + ' ' + signedLine_(la), sideB: sb + ' ' + signedLine_(-la), sideHome: A === h,
        overOdds: price(A), underOdds: price(B), impliedOver: impliedProb_(price(A)), impliedUnder: impliedProb_(price(B)), fairKnown: true }));
    });
    if (sp.length) out.periods.push(best(sp));
    // Moneyline: 2-way only (a row without a team is a "tie" outcome -> skip).
    var mr = byType[seg.ml] || [];
    if (mr.length === 2 && mr.every(tid)) {
      var h2 = mr.filter(function(it) { return tid(it) === ev.homeId; })[0], a2 = mr.filter(function(it) { return tid(it) === ev.awayId; })[0];
      if (h2 && a2) {
        var A2 = price(h2) <= price(a2) ? h2 : a2, B2 = A2 === h2 ? a2 : h2, f2 = fair2(price(A2), price(B2));
        if (inBand(f2)) out.periods.push(make(seg, 'ml', A2, B2, f2, { market: 'Moneyline ' + abbr(tid(A2)), line: 0,
          sideA: abbr(tid(A2)) + ' wins', sideB: abbr(tid(B2)) + ' wins', sideHome: A2 === h2,
          overOdds: price(A2), underOdds: price(B2), impliedOver: impliedProb_(price(A2)), impliedUnder: impliedProb_(price(B2)), fairKnown: true }));
      }
    }
    // Game total for the segment.
    var tr = (byType[seg.total] || []).filter(function(it) { return !tid(it); });
    var t1 = totals(seg, tr, 'total', function(line) { return { market: 'Total ' + line }; });
    if (t1) out.periods.push(t1);
  });
  (cfg.team || []).forEach(function(tt) {
    [ev.homeId, ev.awayId].forEach(function(id) {
      var rows = (byType[tt.type] || []).filter(function(it) { return tid(it) === id; });
      var b = totals(tt, rows, 'teamTotal', function(line) {
        return { market: abbr(id) + ' Total ' + line, sideHome: id === ev.homeId,
                 sideA: abbr(id) + ' Over ' + line, sideB: abbr(id) + ' Under ' + line };
      });
      if (b) out.team.push(b);
    });
  });
  return out;
}

function getGameBets(league, homeTeam, awayTeam, commenceTime) {
  var cfg = GAME_BETS[league], pcfg = PROP_MARKETS[league];
  if (!cfg || !pcfg) return { periods: [], team: [], reason: 'Not available for ' + league };
  if (!isPickOpen_(commenceTime)) return { periods: [], team: [], reason: 'Picks are locked for this game' };
  var cache = CacheService.getScriptCache();
  var key = 'gamebets_v1_' + Utilities.base64EncodeWebSafe(league + '|' + homeTeam + '|' + awayTeam + '|' + commenceTime);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  try {
    var ev = findEspnEvent_(pcfg, homeTeam, awayTeam, commenceTime);
    if (!ev) return { periods: [], team: [], reason: 'Could not find this game on ESPN' };
    var b, any;
    if (cfg.source === 'kalshi') {
      var series = [];
      cfg.segs.forEach(function(s) { ['spread', 'ml', 'total'].forEach(function(k) { if (s[k]) series.push(s[k]); }); });
      (cfg.team || []).forEach(function(t) { series.push(t.series); });
      var evFor = kalshiEventsFor_(series, homeTeam, awayTeam, commenceTime);
      var chosen = series.filter(function(s) { return evFor[s]; });
      var resps = chosen.length ? UrlFetchApp.fetchAll(chosen.map(function(s) {
        return { url: KALSHI_API + '/markets?event_ticker=' + evFor[s].event_ticker + '&limit=1000', muteHttpExceptions: true };
      })) : [];
      var bySeries = {};
      chosen.forEach(function(s, i) { bySeries[s] = kalshiParse_(resps[i]).markets || []; });
      b = buildKalshiGameBets_(cfg, bySeries, ev, homeTeam, awayTeam);
      any = chosen.length > 0;
    } else {
      var rows = fetchPropRows_(pcfg, ev.id);
      b = buildGameBets_(rows, cfg, ev);
      any = rows.some(function(it) { return !it.athlete && it.odds && it.odds.american; });
    }
    b.periods.concat(b.team).forEach(function(p) { p.eventId = ev.id; p.sport = pcfg.sport; p.espnLeague = pcfg.league; });
    b.reason = !any ? 'Game bets not posted for this game yet' : 'None close to 50/50 for this game';
    b.fetchedAt = new Date().toISOString();
    try { cache.put(key, JSON.stringify(b), PROP_CACHE_SEC); } catch (e) {}
    return b;
  } catch (e) {
    return { periods: [], team: [], reason: 'Game bets unavailable right now' };
  }
}

// Points for one team over periods [first, last] from ESPN linescores (last null = to the end).
function segPoints_(competitor, periods) {
  var ls = (competitor || {}).linescores || [], s = 0;
  var end = periods[1] == null ? ls.length : Math.min(periods[1], ls.length);
  for (var i = periods[0] - 1; i < end; i++) {
    s += Number(ls[i].displayValue != null ? ls[i].displayValue : ls[i].value) || 0;
  }
  return s;
}

// Side A / side B segment scores from an ESPN summary, or null if the segment isn't in the data.
function gameBetScores_(meta, summary) {
  var comps = ((((summary || {}).header || {}).competitions || [])[0] || {}).competitors || [];
  var home = comps.filter(function(c) { return c.homeAway === 'home'; })[0];
  var away = comps.filter(function(c) { return c.homeAway === 'away'; })[0];
  if (!home || !away) return null;
  var A = meta.sideHome ? home : away, B = meta.sideHome ? away : home;
  return { a: segPoints_(A, meta.periods), b: segPoints_(B, meta.periods),
           aAbbr: (A.team || {}).abbreviation || '', bAbbr: (B.team || {}).abbreviation || '',
           played: Math.min(((A.linescores || []).length), ((B.linescores || []).length)) };
}

// Pure: 'A' | 'B' | 'push'. Side A = favorite (spread/ML) or Over (totals).
function gameBetOutcome_(meta, line, sc) {
  var d = meta.betType === 'spread' ? sc.a + line - sc.b
        : meta.betType === 'ml' ? sc.a - sc.b
        : meta.betType === 'total' ? sc.a + sc.b - line
        : sc.a - line;   // teamTotal: side A's team
  return d > 0 ? 'A' : d < 0 ? 'B' : 'push';
}

function gameBetScoreText_(meta, sc) {
  return meta.betType === 'total' ? 'total ' + (sc.a + sc.b) + ' (' + sc.aAbbr + ' ' + sc.a + '-' + sc.b + ' ' + sc.bAbbr + ')'
       : meta.betType === 'teamTotal' ? sc.aAbbr + ' ' + sc.a
       : sc.aAbbr + ' ' + sc.a + '-' + sc.b + ' ' + sc.bAbbr;
}

function gradeGameBet_(meta, line, favPicker, summary) {
  var sc = gameBetScores_(meta, summary);
  var label = meta.segment + ' ' + (meta.market || '');
  if (!sc || (meta.periods[1] != null && sc.played < meta.periods[1])) {
    return { error: label + ': period scores missing from ESPN (game shortened?) - grade by hand' };
  }
  if (isNaN(line)) line = Number(meta.line);
  var o = gameBetOutcome_(meta, line, sc);
  var scoreStr = label + ': ' + gameBetScoreText_(meta, sc) + ' -> ' + (o === 'push' ? 'push' : o === 'A' ? meta.sideA : meta.sideB);
  if (o === 'push') return { scoreStr: scoreStr, winner: 'Split', amt: 0 };
  return { scoreStr: scoreStr, winner: o === 'A' ? favPicker : (favPicker === 'Matt' ? 'Sam' : 'Matt'), amt: BET_AMOUNT };
}

// Live card data for a game bet: who is covering right now.
function liveGameBet_(meta, summary) {
  var st = summaryStatus_(summary), sc = gameBetScores_(meta, summary);
  if (!sc) return { state: st.state, detail: st.detail };
  var o = gameBetOutcome_(meta, Number(meta.line), sc);
  return { state: st.state, detail: st.detail, coverA: o === 'push' ? null : o === 'A',
           text: meta.segment + ': ' + gameBetScoreText_(meta, sc) };
}

function buildSummary() {
  var ss=SpreadsheetApp.getActiveSpreadsheet(),gl=ss.getSheetByName('Game List'),sum=ss.getSheetByName('Summary');
  var lastRow=gl.getLastRow(); if (lastRow<2) return;
  var data=gl.getRange(2,1,lastRow-1,10).getValues();

  var bettors=['Matt','Sam'],stats={};
  var unpaidBalance=0;
  bettors.forEach(function(b){
    stats[b]={wins:0,losses:0,won:0,lost:0,streak:0,streakDir:'',results:[],byLeague:{},monthly:{},bigWin:null,bigLoss:null};
  });

  data.forEach(function(r){
    var league=r[1],winner=normWinner_(r[7]),amt=parseFloat(r[8])||0,paid=r[9]==='X';
    var date=r[0]?new Date(r[0]):null;
    var monthKey=date?(date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')):'unknown';
    var game=r[2]; if (!winner) return; // blank or split: not a win or a loss
    if (!paid) unpaidBalance+=(winner==='Matt')?amt:-amt;
    bettors.forEach(function(b){
      var won=winner===b,s=stats[b];
      if (won){s.wins++;s.won+=amt;s.results.push('W');}
      else{s.losses++;s.lost+=amt;s.results.push('L');}
      if (!s.byLeague[league]) s.byLeague[league]={wins:0,losses:0,net:0};
      if (won){s.byLeague[league].wins++;s.byLeague[league].net+=amt;}
      else{s.byLeague[league].losses++;s.byLeague[league].net-=amt;}
      if (!s.monthly[monthKey]) s.monthly[monthKey]=0;
      s.monthly[monthKey]+=won?amt:-amt;
      if (won&&(s.bigWin===null||amt>s.bigWin.amt)) s.bigWin={game:game,amt:amt};
      if (!won&&(s.bigLoss===null||amt>s.bigLoss.amt)) s.bigLoss={game:game,amt:amt};
    });
  });

  bettors.forEach(function(b){
    var res=stats[b].results;
    if(!res.length)return;
    var last2=res[res.length-1],cnt=0;
    for(var i=res.length-1;i>=0;i--){if(res[i]===last2)cnt++;else break;}
    stats[b].streak=cnt;stats[b].streakDir=last2;
  });

  sum.clearContents();sum.clearFormats();
  var row=1;
  sum.getRange(row,1).setValue('SAM vs MATT BETTING TRACKER').setFontWeight('bold').setFontSize(14).setFontColor('#1a73e8');
  row+=2;
  sum.getRange(row,1,1,8).setValues([['Bettor','Wins','Losses','W%','Net $','Streak','Biggest Win','Biggest Loss']]).setFontWeight('bold').setBackground('#f0f4ff');
  row++;
  bettors.forEach(function(b){
    var s=stats[b],tot=s.wins+s.losses,wpct=tot>0?(s.wins/tot*100).toFixed(1)+'%':'--',net=s.won-s.lost;
    var bigW=s.bigWin?s.bigWin.game.substring(0,20)+' ($'+s.bigWin.amt+')':'--';
    var bigL=s.bigLoss?s.bigLoss.game.substring(0,20)+' ($'+s.bigLoss.amt+')':'--';
    sum.getRange(row,1,1,8).setValues([[b,s.wins,s.losses,wpct,net,s.streakDir+s.streak,bigW,bigL]]);
    sum.getRange(row,5).setBackground(net>=0?'#c6efce':'#ffc7ce');
    sum.getRange(row,6).setBackground(s.streakDir==='W'?'#c6efce':'#ffc7ce');
    row++;
  });

  row++;
  var mW=stats['Matt'].wins,sW=stats['Sam'].wins,tot2=mW+sW,mPct=tot2>0?Math.round(mW/tot2*100):50;
  sum.getRange(row,1).setValue('Head to Head').setFontWeight('bold');
  sum.getRange(row,2).setValue('Matt '+mPct+'%  |  Sam '+(100-mPct)+'%');
  sum.getRange(row,1,1,8).setBackground('#f0f4ff');

  row+=2;
  sum.getRange(row,1).setValue('CURRENT BALANCE (unpaid)').setFontWeight('bold').setFontSize(11).setFontColor('#1a73e8');
  row++;
  sum.getRange(row,1,1,3).setValues([['Bettor','Balance','Status']]).setFontWeight('bold').setBackground('#f0f4ff');
  row++;
  var mBal=unpaidBalance,sBal=-unpaidBalance;
  var mStr=mBal===0?'$0':(mBal>0?'+$'+mBal.toFixed(2):'-$'+Math.abs(mBal).toFixed(2));
  var sStr=sBal===0?'$0':(sBal>0?'+$'+sBal.toFixed(2):'-$'+Math.abs(sBal).toFixed(2));
  var mSt=mBal>0?'Sam owes Matt $'+mBal.toFixed(2):mBal<0?'Matt owes Sam $'+Math.abs(mBal).toFixed(2):'Even';
  var sSt=sBal>0?'Matt owes Sam $'+sBal.toFixed(2):sBal<0?'Sam owes Matt $'+Math.abs(sBal).toFixed(2):'Even';
  sum.getRange(row,1,1,3).setValues([['Matt',mStr,mSt]]);
  sum.getRange(row,2).setBackground(mBal>=0?'#c6efce':'#ffc7ce');
  row++;
  sum.getRange(row,1,1,3).setValues([['Sam',sStr,sSt]]);
  sum.getRange(row,2).setBackground(sBal>=0?'#c6efce':'#ffc7ce');

  row+=2;
  sum.getRange(row,1).setValue('BY LEAGUE').setFontWeight('bold').setFontSize(11).setFontColor('#1a73e8');
  row++;
  sum.getRange(row,1,1,6).setValues([['League','Matt W','Matt L','Matt Net','Sam W','Sam L']]).setFontWeight('bold').setBackground('#f0f4ff');
  row++;
  var leagues={};
  bettors.forEach(function(b){Object.keys(stats[b].byLeague).forEach(function(l){leagues[l]=true;});});
  Object.keys(leagues).sort().forEach(function(l){
    var m2=stats['Matt'].byLeague[l]||{wins:0,losses:0,net:0},s2=stats['Sam'].byLeague[l]||{wins:0,losses:0,net:0};
    sum.getRange(row,1,1,6).setValues([[l,m2.wins,m2.losses,'$'+m2.net,s2.wins,s2.losses]]);
    sum.getRange(row,4).setBackground(m2.net>=0?'#c6efce':'#ffc7ce');
    row++;
  });

  row++;
  sum.getRange(row,1).setValue('MONTHLY NET').setFontWeight('bold').setFontSize(11).setFontColor('#1a73e8');
  row++;
  sum.getRange(row,1,1,3).setValues([['Month','Matt Net','Sam Net']]).setFontWeight('bold').setBackground('#f0f4ff');
  row++;
  var allMonths={};
  bettors.forEach(function(b){Object.keys(stats[b].monthly).forEach(function(mo){allMonths[mo]=true;});});
  Object.keys(allMonths).sort().forEach(function(mo){
    var mn=stats['Matt'].monthly[mo]||0,sn2=stats['Sam'].monthly[mo]||0;
    sum.getRange(row,1,1,3).setValues([[mo,'$'+mn,'$'+sn2]]);
    sum.getRange(row,2).setBackground(mn>=0?'#c6efce':'#ffc7ce');
    sum.getRange(row,3).setBackground(sn2>=0?'#c6efce':'#ffc7ce');
    row++;
  });

  sum.autoResizeColumns(1,8);
  Logger.log('Summary rebuilt.');
}

function scheduledRefresh() {
  var result=autoUpdateScores();
  Logger.log('Scores updated: '+result.updated+' games, '+result.pending+' pending.');
  buildSummary();
  Logger.log('Summary rebuilt.');
}

function dailyPayoutAlert() {
  var stats=getPayoutPeriodStats();
  if (stats.payoutDue<20) return;
  var subject='💰 Matt vs Sam Bet Tracker: Payout Due — $'+stats.payoutDue;
  var body=[
    'Hey! The Sam vs Matt bet tracker is showing a payout is due.',
    '',
    stats.owes+' owes '+stats.owed+' $'+stats.payoutDue.toFixed(2),
    '(Outstanding unpaid balance: $'+stats.absBalance.toFixed(2)+')',
    '',
    'Period started: '+stats.periodStart+' ('+stats.daysSinceStart+' days ago)',
    'Games in period: '+stats.games.length,
    '',
    'This is a $'+stats.payoutDue+' payout ('+Math.floor(stats.absBalance/20)+' x $20 increment'+(Math.floor(stats.absBalance/20)>1?'s':'')+').',
    '',
    'View the tracker: https://lomas282-tech.github.io/Matt-vs-Sam',
  ].join('\n');
  var to = personEmail_('matt'), cc = personEmail_('sam');
  if (!to) { Logger.log('MATT_EMAIL is not set in Script Properties; payout email not sent.'); return; }
  var mail = { to: to, subject: subject, body: body };
  if (cc) mail.cc = cc;
  MailApp.sendEmail(mail);
}

function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==='dailyPayoutAlert')ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyPayoutAlert')
    .timeBased().atHour(0).everyDays(1).inTimezone('America/Chicago').create();
}

function doGet(e) {
  var action=e.parameter.action, result;
  if (action==='getRecentGames') result=getRecentGames();
  else if (action==='getBalance') result=getBalance();
  else if (action==='getGamesForLeague') result=getGamesForLeague(e.parameter.league);
  else if (action==='getGamesForDate') result=getGamesForDate(e.parameter.league, e.parameter.dateStr);
  else if (action==='getLiveScores') result=getLiveScores();
  else if (action==='getPayoutPeriodStats') result=getPayoutPeriodStats();
  else if (action==='getTeamLogos') result=getTeamLogos(e.parameter.league);
  else if (action==='getPlayerProps') result=getPlayerProps(e.parameter.league, e.parameter.home, e.parameter.away, e.parameter.commenceTime);
  else if (action==='getLivePropStats') result=getLivePropStats(e.parameter.rows);
  else if (action==='getGameBets') result=getGameBets(e.parameter.league, e.parameter.home, e.parameter.away, e.parameter.commenceTime);
  else result={error:'Unknown action'};
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Team names + ESPN logo paths for one league, for the logos on the game cards.
// Rows: [displayName, shortDisplayName, location, nickname, abbreviation, logoPath].
// Logo path drops the https://a.espncdn.com/ prefix to stay under the 100KB cache limit.
function getTeamLogos(league) {
  var sportKey = getEspnSportKey(league);
  if (!sportKey || sportKey === 'golf') return [];
  var cache = CacheService.getScriptCache();
  var cacheKey = 'logos_' + league.replace(/\s/g, '_');
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  try {
    // site.api.espn.com returns 403 from Apps Script; site.web.api.espn.com works (verified 2026-11-23).
    var url = 'https://site.web.api.espn.com/apis/site/v2/sports/' + sportKey + '/teams?limit=1000';
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];
    var d = JSON.parse(resp.getContentText());
    var teams = ((((d.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
    var out = [];
    teams.forEach(function(t) {
      t = t.team || {};
      var logo = ((t.logos || [])[0] || {}).href || '';
      if (!logo) return;
      out.push([t.displayName || '', t.shortDisplayName || '', t.location || '', t.name || '',
                t.abbreviation || '', logo.replace('https://a.espncdn.com/', '')]);
    });
    try { cache.put(cacheKey, JSON.stringify(out), 21600); } catch (e) {} // 6h
    return out;
  } catch (e) {
    return [];
  }
}

function doPost(e) {
  var payload=JSON.parse(e.postData.contents), action=payload.action, result;
  if (action==='addGame') result=addGame(payload.data);
  else if (action==='updateGame') result=updateGame(payload.data);
  else if (action==='autoUpdateScores') result=autoUpdateScores();
  else if (action==='resolveScore') result=resolveScore(payload.data);
  else if (action==='processPayout') result=processPayout();
  else result={error:'Unknown action'};
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function getBalance() {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();
  if (lastRow<2) return {mattWins:0,samWins:0,mattNet:0,samNet:0,unpaidBalance:0,payoutDue:0,owes:'',owed:'',byLeague:{},byMonth:{},byWeek:{},currentMonthKey:'',currentWeekKey:''};

  var data=sheet.getRange(2,1,lastRow-1,10).getValues();
  var unpaidBalance=0,mattWins=0,samWins=0,mattNet=0,samNet=0,byLeague={},byMonth={},byWeek={};
  var now=new Date();
  var dayOfWeek=now.getDay();
  var weekStart=new Date(now);
  weekStart.setDate(now.getDate()-dayOfWeek);
  weekStart.setHours(0,0,0,0);
  var currentMonthKey=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  var currentWeekKey=Utilities.formatDate(weekStart,'America/Chicago','yyyy-MM-dd');

  for (var i=0;i<data.length;i++){
    var r=data[i]; if (!r[2]||!r[7]) continue;
    var amt=parseFloat(r[8])||0,winner=normWinner_(r[7]),paid=r[9]==='X',league=r[1]||'Other';
    if (!winner) continue; // split: not a win or a loss
    var gameDate=r[0]?new Date(r[0]):null;

    // Net = money won minus money lost (each $ won by one side is lost by the other)
    if (!byLeague[league]) byLeague[league]={mattWins:0,mattLosses:0,samWins:0,samLosses:0,mattNet:0,samNet:0};
    if (winner==='Matt'){
      mattWins++;mattNet+=amt;samNet-=amt;
      byLeague[league].mattWins++;byLeague[league].mattNet+=amt;byLeague[league].samNet-=amt;byLeague[league].samLosses++;
      if (!paid) unpaidBalance+=amt;
    } else {
      samWins++;samNet+=amt;mattNet-=amt;
      byLeague[league].samWins++;byLeague[league].samNet+=amt;byLeague[league].mattNet-=amt;byLeague[league].mattLosses++;
      if (!paid) unpaidBalance-=amt;
    }

    if (gameDate){
      var mk=gameDate.getFullYear()+'-'+String(gameDate.getMonth()+1).padStart(2,'0');
      if (!byMonth[mk]) byMonth[mk]={mattWins:0,mattLosses:0,samWins:0,samLosses:0,mattNet:0,samNet:0};
      if (winner==='Matt'){byMonth[mk].mattWins++;byMonth[mk].mattNet+=amt;byMonth[mk].samNet-=amt;byMonth[mk].samLosses++;}
      else{byMonth[mk].samWins++;byMonth[mk].samNet+=amt;byMonth[mk].mattNet-=amt;byMonth[mk].mattLosses++;}
    }

    if (gameDate&&gameDate>=weekStart){
      if (!byWeek[currentWeekKey]) byWeek[currentWeekKey]={mattWins:0,mattLosses:0,samWins:0,samLosses:0,mattNet:0,samNet:0};
      if (winner==='Matt'){byWeek[currentWeekKey].mattWins++;byWeek[currentWeekKey].mattNet+=amt;byWeek[currentWeekKey].samNet-=amt;byWeek[currentWeekKey].samLosses++;}
      else{byWeek[currentWeekKey].samWins++;byWeek[currentWeekKey].samNet+=amt;byWeek[currentWeekKey].mattNet-=amt;byWeek[currentWeekKey].mattLosses++;}
    }
  }

  return {
    mattWins:mattWins,samWins:samWins,mattNet:mattNet,samNet:samNet,
    unpaidBalance:unpaidBalance,
    payoutDue:Math.floor(Math.abs(unpaidBalance)/20)*20,
    owes:unpaidBalance>0?'Sam':'Matt',
    owed:unpaidBalance>0?'Matt':'Sam',
    byLeague:byLeague,byMonth:byMonth,byWeek:byWeek,
    currentMonthKey:currentMonthKey,currentWeekKey:currentWeekKey
  };
}
