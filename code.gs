// SAM VS MATT BETTING TRACKER
// ─── CONFIG ───────────────────────────────────────────────────────────────────
var BET_AMOUNT = 5;          // default payout per winning bet (change here only)
var RECENT_GAMES_COUNT = 49; // how many sheet rows to show in Recent Games
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
    'Champions League': 'soccer_uefa_champions_league'
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

function getGamesForLeague(league) {
  try {
    var sportKey = getSportKey(league);
    if (!sportKey) return [];

    // ── Cache check ──────────────────────────────────────────────────────────
    var cache = CacheService.getScriptCache();
    var cacheKey = 'odds_' + league.replace(/\s/g, '_');
    var cached = cache.get(cacheKey);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && parsed.length) return parsed;
    }
    // ────────────────────────────────────────────────────────────────────────

    var url = 'https://api.the-odds-api.com/v4/sports/' + sportKey +
      '/odds/?apiKey=7d2ddd074c8eb70572c33f7044136f70&regions=us&markets=spreads,h2h,totals&oddsFormat=american&dateFormat=iso';
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    var data = JSON.parse(resp.getContentText());
    if (!Array.isArray(data)) return [];

    var isCollege = (league === 'NCAA F' || league === 'NCAA MBB');
    // Soccer leagues use full team names (no abbreviation needed)
    var isSoccer = (league === 'Premier League' || league === 'Champions League');
    var now = new Date();
    var cutoff = new Date(now.getTime() - 30 * 60 * 1000);

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
      if (!options.length) continue;

      // Sort by "closest to 50/50" (lowest score = closest to -110 on both sides)
      options.sort(function(a, b) { return a.score - b.score; });
      var best = options[0] || {};

      games.push({
        homeTeam: g.home_team, awayTeam: g.away_team,
        sheetHome: sn(g.home_team), sheetAway: sn(g.away_team),
        isCollege: isCollege,
        isSoccer: isSoccer,
        label: localDateTime + ' — ' + g.away_team + ' @ ' + g.home_team + ' — ' + (best.label || ''),
        displayDate: localDateTime,
        startingSoon: startingSoon,
        options: options, bestType: best.type,
        favorite: best.favorite, line: best.line,
        oddsStr: best.oddsStr, marketType: best.type,
        gameDate: localDate, commenceTime: g.commence_time
      });
    }

    games.sort(function(a, b) { return new Date(a.commenceTime) - new Date(b.commenceTime); });

    // ── Store in cache for 6 hours ───────────────────────────────────────────
    try { cache.put(cacheKey, JSON.stringify(games), 21600); } catch(e) {}
    // ────────────────────────────────────────────────────────────────────────

    return games;
  } catch(e) { return [{ error: e.toString() }]; }
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
// NEW LOGIC:
//   1. If commenceTime is provided: match on game + commenceTime (unique per event)
//   2. Fallback (manual entry): match on game + date + line (lines differ per game in a series)
// ─────────────────────────────────────────────────────────────────────────────
function addGame(d) {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Game List');
  var lastRow=sheet.getLastRow();

  if (lastRow>=2) {
    var existing=sheet.getRange(2,1,lastRow-1,11).getValues();
    var inputGame = (d.game||'').toLowerCase().trim();
    var inputCommenceTime = (d.commenceTime||'').trim();
    var inputLine = (d.line||'').toString().trim();

    for (var i=0;i<existing.length;i++){
      var eGame = (existing[i][2]||'').toString().toLowerCase().trim();
      if (eGame !== inputGame) continue;

      // Strategy 1: If we have commenceTime, use it as the unique key
      if (inputCommenceTime) {
        var eCommenceTime = (existing[i][10]||'').toString().trim();
        if (eCommenceTime === inputCommenceTime) {
          return {duplicate:true, row:i+2, reason:'Same game + start time already exists'};
        }
        // Different commence time = different game in series, allow it
        continue;
      }

      // Strategy 2: Fallback for manual entries — match on game + date + line
      var inputDate = d.date ? Utilities.formatDate(new Date(d.date), Session.getScriptTimeZone(), 'M/d/yyyy') : '';
      var eDate = existing[i][0] ? Utilities.formatDate(new Date(existing[i][0]), Session.getScriptTimeZone(), 'M/d/yyyy') : '';
      var eLine = (existing[i][3]||'').toString().trim();

      if (eDate === inputDate && eLine === inputLine) {
        return {duplicate:true, row:i+2, reason:'Same game + date + line already exists'};
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

  return {success:true, row:row};
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
  var vals=sheet.getRange(start,1,lastRow-start+1,11).getValues();
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
      time:timeStr, commenceTime:ct
    });
  }
  return out;
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
    var amt=parseFloat(r[8])||0, winner=r[7];
    var gameDate=r[0]?new Date(r[0]):null;
    if (gameDate && (!earliestDate || gameDate < earliestDate)) {
      earliestDate = gameDate;
    }
    if (winner==='Matt'){mattWins++;mattNet+=amt;samLosses++;unpaidBalance+=amt;}
    else {samWins++;samNet+=amt;mattLosses++;unpaidBalance-=amt;}
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
  unpaid.forEach(function(g){ balance+=(g.winner==='Matt')?g.amt:-g.amt; });
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

  var data=sheet.getRange(2,1,lastRow-1,11).getValues();
  var errors=[],updated=0,pending=0,groups={};

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
    var league=r[1],winner=r[7],amt=parseFloat(r[8])||0,paid=r[9]==='X';
    var date=r[0]?new Date(r[0]):null;
    var monthKey=date?(date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')):'unknown';
    var game=r[2]; if (!winner||winner==='') return;
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
  MailApp.sendEmail({
    to: 'lomas282@gmail.com',
    cc: 'sammynewman1985@gmail.com',
    subject: subject,
    body: body
  });
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
  else result={error:'Unknown action'};
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
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
    var amt=parseFloat(r[8])||0,winner=r[7],paid=r[9]==='X',league=r[1]||'Other';
    var gameDate=r[0]?new Date(r[0]):null;

    if (!byLeague[league]) byLeague[league]={mattWins:0,mattLosses:0,samWins:0,samLosses:0,mattNet:0,samNet:0};
    if (winner==='Matt'){
      mattWins++;mattNet+=amt;
      byLeague[league].mattWins++;byLeague[league].mattNet+=amt;byLeague[league].samLosses++;
      if (!paid) unpaidBalance+=amt;
    } else {
      samWins++;samNet+=amt;
      byLeague[league].samWins++;byLeague[league].samNet+=amt;byLeague[league].mattLosses++;
      if (!paid) unpaidBalance-=amt;
    }

    if (gameDate){
      var mk=gameDate.getFullYear()+'-'+String(gameDate.getMonth()+1).padStart(2,'0');
      if (!byMonth[mk]) byMonth[mk]={mattWins:0,mattLosses:0,samWins:0,samLosses:0,mattNet:0,samNet:0};
      if (winner==='Matt'){byMonth[mk].mattWins++;byMonth[mk].mattNet+=amt;byMonth[mk].samLosses++;}
      else{byMonth[mk].samWins++;byMonth[mk].samNet+=amt;byMonth[mk].mattLosses++;}
    }

    if (gameDate&&gameDate>=weekStart){
      if (!byWeek[currentWeekKey]) byWeek[currentWeekKey]={mattWins:0,mattLosses:0,samWins:0,samLosses:0,mattNet:0,samNet:0};
      if (winner==='Matt'){byWeek[currentWeekKey].mattWins++;byWeek[currentWeekKey].mattNet+=amt;byWeek[currentWeekKey].samLosses++;}
      else{byWeek[currentWeekKey].samWins++;byWeek[currentWeekKey].samNet+=amt;byWeek[currentWeekKey].mattLosses++;}
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

