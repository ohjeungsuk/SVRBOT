// index.js (discord.js v12.5.3 + Google Sheets logger + GPT API via OpenAI Responses + !복귀 + PartyBeast room renumber + PUBG Patch Notes)
// Required Heroku Config Vars:
// - DISCORD_TOKEN
// - GOOGLE_SA_JSON_B64
// - OPENAI_API_KEY
// Optional:
// - OPENAI_MODEL (default: gpt-4o-mini)
// - OPENAI_MAX_TOKENS (default: 160)
// - OPENAI_TIMEOUT_MS (default: 25000)
//
// Recommended Heroku dynos: worker=1, web=0

const Discord = require('discord.js');
const { google } = require('googleapis');
const https = require('https');

const client = new Discord.Client({
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});

const prefix = '!';
let latestTeams = [];

// ---- OpenAI Settings ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '160', 10);
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '25000', 10);

// ---- AI Channel 인증 (길드별 1개 채널) ----
const aiChannelByGuild = new Map(); // guildId -> channelId
const aiQueueByGuild = new Map();   // guildId -> Promise
const aiHistoryByChannel = new Map(); // key: guildId:channelId -> [{role, text}]
const aiCooldownByUser = new Map(); // userId -> lastTimestamp(ms)

// ---- Google Sheets Settings ----
const TARGET_CHANNEL_ID = '1439239707320909895';
const SPREADSHEET_ID = '1WzlRm6jlOGxTz4dTgbdMopzcJCNop8dnz7kP9GsMXZs';
const SHEET_TITLE_FIXED = '카톡외출목록';
const BACKUP_MAX_MESSAGES = 20000;

// ---- 복귀(대기실) Settings ----
const WAITING_ROOM_VOICE_ID = '1453266042439860224';
const lastDisbandedMemberIds = new Set(); // !해산으로 이동된 사람 id 저장

// ---- PartyBeast Room Renumber Settings ----
const REN_NUMBER_DELAY_MS = 2000;      // 파티비스트 생성/삭제 이후 기다리는 시간
const REN_RENAME_GAP_MS = 700;         // rename 연속 호출 간 간격(레이트리밋 완화)

const MANAGED_ROOM_CATEGORIES = [
  { categoryId: '1456630426247499918', prefix: '듀오방' },
  { categoryId: '1453251021282476084', prefix: '일반방' },
  { categoryId: '1453251462586171446', prefix: '경쟁방' },
  { categoryId: '1453257882438205531', prefix: '빡겜방' },
];

const managedCategoryMap = new Map();
for (let i = 0; i < MANAGED_ROOM_CATEGORIES.length; i++) {
  managedCategoryMap.set(String(MANAGED_ROOM_CATEGORIES[i].categoryId), MANAGED_ROOM_CATEGORIES[i]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 팀 셔플용: Fisher–Yates 셔플 (기존 sort(Math.random)보다 훨씬 랜덤성 좋음)
function shuffleArray(inputArray) {
  const arr = inputArray.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// sheet job serialize
let sheetQueue = Promise.resolve();
function enqueueSheetJob(fn) {
  sheetQueue = sheetQueue.then(fn).catch((err) => {
    console.error('[SheetJobError]', err && err.stack ? err.stack : err);
  });
  return sheetQueue;
}

function enqueueAiJob(guildId, fn) {
  const prev = aiQueueByGuild.get(guildId) || Promise.resolve();
  const next = prev.then(fn).catch((err) => {
    console.error('[AIJobError]', err && err.stack ? err.stack : err);
  });
  aiQueueByGuild.set(guildId, next);
  return next;
}

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing env var: ' + name);
  return v;
}

function safeShort(str, maxLen) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

function parseServiceAccountFromB64() {
  const b64 = getEnv('GOOGLE_SA_JSON_B64');
  const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  const creds = JSON.parse(jsonStr);

  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

// KST 문자열 (YYYY-MM-DD HH:mm:ss)
function formatKSTFromDate(dateObj) {
  const t = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
  const iso = t.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}

function buildMessageLink(message) {
  const guildId = message.guild ? message.guild.id : '@me';
  return 'https://discord.com/channels/' + guildId + '/' + message.channel.id + '/' + message.id;
}

// thread 지원: parentID가 타겟 채널이면 true
function isTargetChannelOrThread(message) {
  if (!message || !message.channel) return false;

  const cid = String(message.channel.id);
  if (cid === TARGET_CHANNEL_ID) return true;

  if (message.channel.parentID && String(message.channel.parentID) === TARGET_CHANNEL_ID) {
    return true;
  }
  return false;
}

function a1Range(sheetTitle, a1) {
  const safe = String(sheetTitle).replace(/'/g, "''");
  return "'" + safe + "'!" + a1;
}

// 입력 양식 파서
function parseLeaveForm(content) {
  if (!content) return null;

  const lines = String(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let nickname = '';
  let reason = '';
  let period = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([^:]+)\s*:\s*(.*)$/);
    if (!m) continue;

    const key = String(m[1]).replace(/\s/g, '');
    const val = String(m[2]).trim();

    if (key === '닉네임') nickname = val;
    else if (key === '사유') reason = val;
    else if (key === '기간') period = val;
  }

  if (!nickname || !reason || !period) return null;
  return { nickname, reason, period };
}

let sheetsApi = null;
let SHEET_TITLE = null;

// 메시지ID->행번호 캐시. 메모리 상한 유지.
const msgRowCache = new Map();
const MSG_ROW_CACHE_MAX = 5000;
function msgRowCacheSet(mid, row) {
  if (msgRowCache.size >= MSG_ROW_CACHE_MAX) {
    const it = msgRowCache.keys().next();
    if (!it.done) msgRowCache.delete(it.value);
  }
  msgRowCache.set(String(mid), row);
}

async function initSheets() {
  if (sheetsApi && SHEET_TITLE) return;

  const creds = parseServiceAccountFromB64();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsApi = google.sheets({ version: 'v4', auth });
  SHEET_TITLE = SHEET_TITLE_FIXED;

  console.log('[Sheets] LeaveSheetTitle(Fixed):', SHEET_TITLE);
  console.log('[Sheets] SpreadsheetId:', SPREADSHEET_ID);
}

function extractRowNumberFromUpdatedRange(updatedRange) {
  if (!updatedRange) return null;
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

async function appendLeaveRow(message) {
  await initSheets();

  const parsed = parseLeaveForm(message.content);
  if (!parsed) {
    console.log('[Leave][Skip] format not matched', 'mid=' + message.id, 'content=' + safeShort(message.content, 120));
    return;
  }

  const registeredAtKST = formatKSTFromDate(message.createdAt);
  const row = [parsed.nickname, parsed.reason, parsed.period, registeredAtKST];

  const range = a1Range(SHEET_TITLE, 'A:D');

  console.log('[Leave][Append] try', 'mid=' + message.id, 'nick=' + safeShort(parsed.nickname, 30), 'time(KST)=' + registeredAtKST);

  const res = await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  const updatedRange = res && res.data && res.data.updates ? res.data.updates.updatedRange : null;
  const rowNum = extractRowNumberFromUpdatedRange(updatedRange);
  if (rowNum) msgRowCacheSet(String(message.id), rowNum);

  console.log('[Leave][Append] ok', 'mid=' + message.id, 'row=' + (rowNum ? rowNum : 'unknown'));
}

async function updateLeaveRowFromEdit(message) {
  await initSheets();

  const rowNum = msgRowCache.get(String(message.id));
  if (!rowNum) {
    console.log('[Leave][Edit] skip (row not cached)', 'mid=' + message.id);
    return;
  }

  const parsed = parseLeaveForm(message.content);
  if (!parsed) {
    console.log('[Leave][Edit] skip (format not matched)', 'mid=' + message.id);
    return;
  }

  const range = a1Range(SHEET_TITLE, 'A' + rowNum + ':C' + rowNum);

  console.log('[Leave][Edit] try', 'mid=' + message.id, 'row=' + rowNum);

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    requestBody: { values: [[parsed.nickname, parsed.reason, parsed.period]] },
  });

  console.log('[Leave][Edit] ok', 'mid=' + message.id, 'row=' + rowNum);
}

// ---------- Backup 기능 ----------
let backupRunning = false;

async function getOrFetchChannel(channelId) {
  let ch = client.channels.cache.get(channelId);
  if (ch) return ch;
  try {
    ch = await client.channels.fetch(channelId);
    return ch;
  } catch (e) {
    return null;
  }
}

async function listSheetTitles() {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheets = meta && meta.data && meta.data.sheets ? meta.data.sheets : [];
  const titles = [];
  for (let i = 0; i < sheets.length; i++) {
    const p = sheets[i].properties;
    if (p && p.title) titles.push(String(p.title));
  }
  return titles;
}

function makeBackupBaseTitle(nowKST) {
  const d = nowKST.slice(0, 10);
  return '백업(' + d + ')';
}

function makeUniqueTitle(base, existingTitles) {
  if (existingTitles.indexOf(base) < 0) return base;
  let idx = 1;
  while (idx < 1000) {
    const t = base + '-' + idx;
    if (existingTitles.indexOf(t) < 0) return t;
    idx++;
  }
  return base + '-' + new Date().getTime();
}

async function createSheetTab(title) {
  console.log('[Backup] creating sheet tab:', title);

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: title } } },
      ],
    },
  });

  console.log('[Backup] sheet tab created:', title);
}

async function appendRowsToSheet(sheetTitle, rows, a1) {
  const range = a1Range(sheetTitle, a1);
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function fetchAllMessagesFromChannelText(channel) {
  const all = [];
  let lastId = null;

  while (all.length < BACKUP_MAX_MESSAGES) {
    const opt = { limit: 100 };
    if (lastId) opt.before = lastId;

    let batch;
    try {
      batch = await channel.messages.fetch(opt);
    } catch (e) {
      console.error('[Backup] channel.messages.fetch failed:', e && e.message ? e.message : e);
      break;
    }

    if (!batch || batch.size === 0) break;

    const arr = batch.array();
    for (let i = 0; i < arr.length; i++) all.push(arr[i]);

    lastId = arr[arr.length - 1].id;

    if (all.length % 500 === 0) {
      console.log('[Backup] fetched messages:', all.length);
    }
  }

  return all;
}

async function runBackup(invokingMessage) {
  if (backupRunning) {
    try { await invokingMessage.reply('이미 백업 진행중이야. 끝나면 다시 시도해줘.'); } catch (e) {}
    return;
  }

  backupRunning = true;
  try {
    await initSheets();

    const ch = await getOrFetchChannel(TARGET_CHANNEL_ID);
    if (!ch || ch.type !== 'text') {
      console.error('[Backup] target channel not found or not text:', TARGET_CHANNEL_ID);
      try { await invokingMessage.reply('백업 실패: 채널을 못 찾았거나 텍스트 채널이 아님.'); } catch (e) {}
      return;
    }

    const nowKST = formatKSTFromDate(new Date());
    const base = makeBackupBaseTitle(nowKST);
    const existing = await listSheetTitles();
    const newTitle = makeUniqueTitle(base, existing);

    await createSheetTab(newTitle);

    const header = ['닉네임', '사유', '외출날짜'];
    await appendRowsToSheet(newTitle, [header], 'A:C');

    console.log('[Backup] fetching messages from channel:', TARGET_CHANNEL_ID);

    const msgs = await fetchAllMessagesFromChannelText(ch);
    if (!msgs || msgs.length === 0) {
      try { await invokingMessage.reply('백업 완료(0건). 새 시트: ' + newTitle); } catch (e) {}
      return;
    }

    msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    console.log('[Backup] total messages fetched:', msgs.length);

    const rows = [];
    let matched = 0;

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const parsed = parseLeaveForm(m.content);
      if (!parsed) continue;

      matched++;
      rows.push([parsed.nickname, parsed.reason, parsed.period]);

      if (matched % 500 === 0) {
        console.log('[Backup] matched rows:', matched);
      }
    }

    if (rows.length === 0) {
      console.log('[Backup] no matched leave-form messages');
      try { await invokingMessage.reply('백업 완료(양식 0건). 새 시트: ' + newTitle); } catch (e) {}
      return;
    }

    const CHUNK = 500;
    for (let s = 0; s < rows.length; s += CHUNK) {
      const chunk = rows.slice(s, s + CHUNK);
      await appendRowsToSheet(newTitle, chunk, 'A:C');
      console.log('[Backup] appended:', Math.min(s + CHUNK, rows.length) + '/' + rows.length);
    }

    console.log('[Backup] done. sheet:', newTitle, 'matched:', rows.length);

    try {
      await invokingMessage.reply('백업 완료: 양식 ' + rows.length + '건, 새 시트: ' + newTitle);
    } catch (e) {}
  } catch (e) {
    console.error('[Backup] failed:', e && e.stack ? e.stack : e);
    try { await invokingMessage.reply('백업 실패. Heroku 로그 확인해줘.'); } catch (ee) {}
  } finally {
    backupRunning = false;
  }
}

// ---- OpenAI (Responses API) ----
function extractResponseText(respJson) {
  if (!respJson) return '';
  if (respJson.output && Array.isArray(respJson.output)) {
    let out = '';
    for (let i = 0; i < respJson.output.length; i++) {
      const item = respJson.output[i];
      if (!item || item.type !== 'message' || item.role !== 'assistant') continue;
      const content = item.content;
      if (!content || !Array.isArray(content)) continue;

      for (let j = 0; j < content.length; j++) {
        const c = content[j];
        if (!c) continue;
        if (c.type === 'output_text' && typeof c.text === 'string') out += c.text;
      }
    }
    return String(out || '').trim();
  }
  return '';
}

function callOpenAIResponses(instructions, inputText) {
  return new Promise((resolve) => {
    if (!OPENAI_API_KEY) {
      resolve({ ok: false, errorType: 'missing_key', text: '' });
      return;
    }

    const bodyObj = {
      model: OPENAI_MODEL,
      instructions: instructions,
      input: inputText,
      max_output_tokens: isNaN(OPENAI_MAX_TOKENS) ? 160 : OPENAI_MAX_TOKENS,
      temperature: 0.8,
      store: false,
      text: { format: { type: 'text' } },
    };

    const body = JSON.stringify(bodyObj);

    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/responses',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + OPENAI_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: OPENAI_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { json = null; }

          if (!res || res.statusCode < 200 || res.statusCode >= 300) {
            const code = json && json.error && json.error.code ? String(json.error.code) : '';
            const msg = json && json.error && json.error.message ? String(json.error.message) : ('HTTP ' + res.statusCode);
            const status = res ? res.statusCode : 0;

            if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
              resolve({ ok: false, errorType: 'limit', text: '', raw: msg });
              return;
            }
            resolve({ ok: false, errorType: 'http', text: '', raw: msg });
            return;
          }

          const text = extractResponseText(json);
          resolve({ ok: true, text: text, raw: json });
        });
      }
    );

    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')); } catch (e) {}
      resolve({ ok: false, errorType: 'timeout', text: '' });
    });

    req.on('error', (err) => {
      resolve({ ok: false, errorType: 'network', text: '', raw: err ? err.message : '' });
    });

    req.write(body);
    req.end();
  });
}

function getAiChannelId(message) {
  if (!message || !message.guild) return '';
  return aiChannelByGuild.get(String(message.guild.id)) || '';
}

function isAiChannelOrThread(message) {
  if (!message || !message.guild || !message.channel) return false;

  const aiCid = getAiChannelId(message);
  if (!aiCid) return false;

  if (String(message.channel.id) === String(aiCid)) return true;
  if (message.channel.parentID && String(message.channel.parentID) === String(aiCid)) return true;
  return false;
}

function getChannelHistoryKey(message) {
  if (!message || !message.guild || !message.channel) return '';
  const aiCid = getAiChannelId(message);
  if (!aiCid) return '';
  return String(message.guild.id) + ':' + String(aiCid);
}

function getHistoryFor(message) {
  const key = getChannelHistoryKey(message);
  if (!key) return [];
  const h = aiHistoryByChannel.get(key);
  if (h && Array.isArray(h)) return h;
  return [];
}

function setHistoryFor(message, history) {
  const key = getChannelHistoryKey(message);
  if (!key) return;
  aiHistoryByChannel.set(key, history);
}

function trimHistory(history) {
  if (!history || !Array.isArray(history)) return [];

  const maxItems = 12;
  let h = history.slice(-maxItems);

  let total = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    total += String(h[i].text || '').length;
    if (total > 2500) {
      h = h.slice(i + 1);
      break;
    }
  }
  return h;
}

async function sendLongText(channel, text) {
  if (!channel) return;
  const s = String(text || '').trim();
  if (!s) {
    await channel.send('현재 작동이 불가능 합니다');
    return;
  }

  const LIMIT = 1900;
  if (s.length <= LIMIT) {
    await channel.send(s);
    return;
  }

  let idx = 0;
  while (idx < s.length) {
    const chunk = s.slice(idx, idx + LIMIT);
    idx += LIMIT;
    await channel.send(chunk);
  }
}

function nowMs() {
  return new Date().getTime();
}

function isOnCooldown(userId) {
  const last = aiCooldownByUser.get(String(userId)) || 0;
  const t = nowMs();
  if (t - last < 2000) return true;
  aiCooldownByUser.set(String(userId), t);
  return false;
}

async function handleAiChat(message) {
  if (!message || !message.guild) return;
  if (!isAiChannelOrThread(message)) return;
  if (!message.content) return;

  if (message.content.startsWith(prefix)) return;
  if (parseLeaveForm(message.content)) return;
  if (isOnCooldown(message.author.id)) return;

  const raw = String(message.content).trim();
  if (!raw) return;

  const history = trimHistory(getHistoryFor(message));

  const instructionText =
    '너는 디스코드 채팅용 간단한 대화 봇이다. ' +
    '대답은 짧고 자연스럽게 한다. ' +
    '이름은 리터 라고 한다. ' +
    '나이는 20살이다 ' +
    '과한 설명은 하지 않는다. ' +
    '모르는 내용은 모른다고 말한다.';

  let prompt = '';
  for (let i = 0; i < history.length; i++) {
    const it = history[i];
    if (!it || !it.role) continue;
    const role = it.role === 'user' ? 'User' : 'Assistant';
    prompt += role + ': ' + String(it.text || '') + '\n';
  }
  prompt += 'User: ' + raw + '\nAssistant:';

  history.push({ role: 'user', text: raw });
  setHistoryFor(message, trimHistory(history));

  const result = await callOpenAIResponses(instructionText, prompt);

  if (!result.ok) {
    await message.channel.send('현재 작동이 불가능 합니다');
    return;
  }

  let out = String(result.text || '').trim();
  if (!out) out = '현재 작동이 불가능 합니다';

  const h2 = getHistoryFor(message);
  h2.push({ role: 'assistant', text: out });
  setHistoryFor(message, trimHistory(h2));

  await sendLongText(message.channel, out);
}

// ---- PUBG Patch Notes Helper Functions ----

// PUBG 뉴스 HTML 다운로드
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(15000, () => {
      try { req.destroy(new Error('timeout')); } catch (e) {}
      reject(new Error('timeout'));
    });
  });
}

// 메타 태그에서 og:title / og:image 같은거 뽑기
function extractMetaContent(html, property) {
  const re = new RegExp('<meta[^>]+property="' + property.replace(/"/g, '\\"') + '"[^>]+content="([^"]+)"', 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

// HTML 태그 제거하고 텍스트만 추출
function stripHtmlTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// PUBG 패치노트 본문 영역만 대충 잘라내기
function extractPubgArticleText(html) {
  let body = '';
  let start = html.indexOf('<article');
  if (start >= 0) {
    let end = html.indexOf('</article>', start);
    if (end > start) {
      body = html.slice(start, end + 10);
    }
  }
  if (!body) {
    start = html.indexOf('<main');
    if (start >= 0) {
      const end = html.indexOf('</main>', start);
      if (end > start) {
        body = html.slice(start, end + 7);
      }
    }
  }
  if (!body) {
    body = html;
  }

  let text = stripHtmlTags(body);
  if (text.length > 6000) {
    text = text.slice(0, 6000);
  }
  return text;
}

// news?category=patch_notes 페이지에서 가장 최신 패치노트 글 URL 찾기
function findLatestPatchUrl(listHtml) {
  const marker = '패치 노트 - ';
  const idx = listHtml.indexOf(marker);
  if (idx < 0) return null;

  const slice = listHtml.slice(0, idx);
  const aIdx = slice.lastIndexOf('<a ');
  if (aIdx < 0) return null;

  const aPart = slice.slice(aIdx);
  const hrefMatch = aPart.match(/href="([^"]+)"/i);
  if (!hrefMatch) return null;

  let href = hrefMatch[1];
  if (href.startsWith('//')) {
    href = 'https:' + href;
  } else if (href.startsWith('/')) {
    href = 'https://pubg.com' + href;
  } else if (!href.startsWith('http')) {
    href = 'https://pubg.com' + (href.startsWith('/') ? '' : '/') + href;
  }
  return href;
}

// 최신 패치노트 불러와서 요약까지 수행
async function fetchLatestPubgPatchNoteSummary() {
  const listUrl = 'https://pubg.com/ko/news?category=patch_notes';
  const listHtml = await fetchHtml(listUrl);
  const articleUrl = findLatestPatchUrl(listHtml);
  if (!articleUrl) {
    return { ok: false, reason: 'no_article' };
  }

  const articleHtml = await fetchHtml(articleUrl);
  const title = extractMetaContent(articleHtml, 'og:title') || '배틀그라운드 최신 패치 노트';
  const imageUrl = extractMetaContent(articleHtml, 'og:image') || '';
  const rawText = extractPubgArticleText(articleHtml);

  const instructions =
    '너는 배틀그라운드(PUBG) 패치노트를 한국어로 요약하는 도우미다. ' +
    '입력으로 주어진 텍스트는 패치노트 본문이다. ' +
    '핵심 변경 사항을 5~10개 bullet 목록으로 요약해라. ' +
    '각 bullet은 간단명료하게 쓰고, 굳이 중요하지 않은 자잘한 수치는 생략해도 된다. ' +
    '디스코드 메시지에 바로 붙여 넣을 수 있도록 깔끔한 목록 형태로 출력해라.';

  const input =
    '다음은 배틀그라운드 패치노트 텍스트다.\n\n' +
    rawText +
    '\n\n위 내용을 기반으로 핵심 변경점만 정리해서 bullet 목록으로 요약해줘.';

  const aiResult = await callOpenAIResponses(instructions, input);

  if (!aiResult.ok) {
    // AI 요약 실패 시, 원문 일부만 잘라서 반환
    return {
      ok: true,
      title: title,
      url: articleUrl,
      imageUrl: imageUrl,
      summary: rawText.slice(0, 1500) + '...',
    };
  }

  const summary = aiResult.text && aiResult.text.trim()
    ? aiResult.text.trim()
    : rawText.slice(0, 1500) + '...';

  return {
    ok: true,
    title: title,
    url: articleUrl,
    imageUrl: imageUrl,
    summary: summary,
  };
}

// ---- PartyBeast Room Renumber Implementation ----
const renumberTimers = new Map();      // key: guildId:categoryId -> timeout
const renumberQueues = new Map();      // key: guildId:categoryId -> Promise

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isManagedCategory(categoryId) {
  return managedCategoryMap.has(String(categoryId));
}

function scheduleRenumber(guildId, categoryId, why) {
  if (!guildId || !categoryId) return;
  const cid = String(categoryId);
  if (!isManagedCategory(cid)) return;

  const key = String(guildId) + ':' + cid;
  const old = renumberTimers.get(key);
  if (old) {
    try { clearTimeout(old); } catch (e) {}
  }

  const t = setTimeout(() => {
    enqueueRenumberJob(String(guildId), cid, why);
  }, REN_NUMBER_DELAY_MS);

  renumberTimers.set(key, t);
}

function enqueueRenumberJob(guildId, categoryId, why) {
  const key = String(guildId) + ':' + String(categoryId);
  const prev = renumberQueues.get(key) || Promise.resolve();

  const next = prev.then(async () => {
    try {
      await renumberCategoryRooms(guildId, categoryId, why);
    } catch (e) {
      console.error('[RenumberError]', e && e.stack ? e.stack : e);
    }
  });

  renumberQueues.set(key, next);
  return next;
}

async function renumberCategoryRooms(guildId, categoryId, why) {
  const cfg = managedCategoryMap.get(String(categoryId));
  if (!cfg) return;

  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;

  const prefixText = String(cfg.prefix);
  const re = new RegExp('^' + escapeRegex(prefixText) + '\\s*(\\d+)$', 'i');

  const voices = guild.channels.cache
    .filter((ch) => ch && ch.type === 'voice' && String(ch.parentID) === String(categoryId))
    .array();

  const targets = [];
  for (let i = 0; i < voices.length; i++) {
    const ch = voices[i];
    const name = String(ch.name || '');
    const m = name.match(re);
    if (!m) continue;
    targets.push(ch);
  }

  if (targets.length <= 1) {
    // 1개만 남았으면 1번으로 강제
    if (targets.length === 1) {
      const desired = prefixText + '1';
      if (String(targets[0].name) !== desired) {
        console.log('[Renumber] single channel rename', 'cat=' + categoryId, 'from=' + targets[0].name, 'to=' + desired, 'why=' + String(why || ''));
        try {
          await targets[0].setName(desired, 'renumber(single)');
        } catch (e) {
          console.error('[Renumber] rename failed:', e && e.message ? e.message : e);
        }
      }
    }
    return;
  }

  // 중요: 파티비스트가 빈번호로 생성해도, 오래된 방이 1번이 되게 "생성시간" 기준으로 정렬
  targets.sort((a, b) => {
    const ta = a.createdTimestamp || 0;
    const tb = b.createdTimestamp || 0;
    return ta - tb;
  });

  // 원하는 이름 계산
  const plan = [];
  for (let i = 0; i < targets.length; i++) {
    const desired = prefixText + String(i + 1);
    if (String(targets[i].name) !== desired) {
      plan.push({ ch: targets[i], to: desired });
    }
  }

  if (plan.length === 0) return;

  console.log('[Renumber] start', 'cat=' + categoryId, 'prefix=' + prefixText, 'count=' + targets.length, 'changes=' + plan.length, 'why=' + String(why || ''));

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    try {
      console.log('[Renumber] rename', 'from=' + item.ch.name, 'to=' + item.to);
      await item.ch.setName(item.to, 'renumber');
      await delay(REN_RENAME_GAP_MS);
    } catch (e) {
      console.error('[Renumber] rename failed:', e && e.message ? e.message : e);
    }
  }

  console.log('[Renumber] done', 'cat=' + categoryId);
}

// ---- Global Error/Signal Handling ----
process.on('uncaughtException', (err) => {
  console.error('[FATAL][uncaughtException]', err && err.stack ? err.stack : err);
  try { if (client && client.destroy) client.destroy(); } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL][unhandledRejection]', err && err.stack ? err.stack : err);
  try { if (client && client.destroy) client.destroy(); } catch (e) {}
  process.exit(1);
});

function gracefulShutdown(sig) {
  console.log('[Signal]', sig, 'received. shutting down gracefully.');
  try { if (client && client.destroy) client.destroy(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

client.on('shardReady', (id) => console.log('[ShardReady]', id));
client.on('shardDisconnect', (event, id) => console.log('[ShardDisconnect]', id, 'code=' + (event && event.code)));
client.on('shardReconnecting', (id) => console.log('[ShardReconnecting]', id));
client.on('error', (e) => console.error('[ClientError]', e && e.stack ? e.stack : e));
client.on('warn', (w) => console.warn('[ClientWarn]', w));
client.on('rateLimit', (info) => console.warn('[RateLimit]', JSON.stringify(info)));

setInterval(() => {
  console.log('[Heartbeat]', new Date().toISOString());
}, 10 * 60 * 1000);

// ---- Discord Events ----
client.on('ready', async () => {
  console.log('[Bot] LoggedInAs:', client.user.tag);
  console.log('[Bot] TARGET_CHANNEL_ID:', TARGET_CHANNEL_ID);
  console.log('[Env] DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? 'SET' : 'MISSING');
  console.log('[Env] GOOGLE_SA_JSON_B64:', process.env.GOOGLE_SA_JSON_B64 ? 'SET' : 'MISSING');
  console.log('[Env] OPENAI_API_KEY:', OPENAI_API_KEY ? 'SET' : 'MISSING');
  console.log('[Env] OPENAI_MODEL:', OPENAI_MODEL);

  try {
    await initSheets();
  } catch (e) {
    console.error('[SheetsInitFailed]', e && e.stack ? e.stack : e);
  }
});

// 채널 생성/삭제 감시해서 번호정렬 트리거
client.on('channelCreate', (channel) => {
  try {
    if (!channel) return;
    if (channel.type !== 'voice') return;
    if (!channel.guild) return;
    if (!channel.parentID) return;
    if (!isManagedCategory(channel.parentID)) return;

    scheduleRenumber(channel.guild.id, channel.parentID, 'channelCreate');
  } catch (e) {
    console.error('[channelCreate handler error]', e && e.stack ? e.stack : e);
  }
});

client.on('channelDelete', (channel) => {
  try {
    if (!channel) return;
    if (channel.type !== 'voice') return;
    if (!channel.guild) return;
    if (!channel.parentID) return;
    if (!isManagedCategory(channel.parentID)) return;

    scheduleRenumber(channel.guild.id, channel.parentID, 'channelDelete');
  } catch (e) {
    console.error('[channelDelete handler error]', e && e.stack ? e.stack : e);
  }
});

// 메시지 작성 시
client.on('message', async (message) => {
  if (!message || !message.author) return;
  if (message.author.bot) return;

  // 기존: 타겟 채널 양식 기록
  if (isTargetChannelOrThread(message)) {
    console.log(
      '[MSG] recv',
      'cid=' + message.channel.id,
      'mid=' + message.id,
      'created(KST)=' + formatKSTFromDate(message.createdAt),
      'content=' + safeShort(message.content, 140)
    );
    enqueueSheetJob(() => appendLeaveRow(message));
  }

  // AI 대화: 인증된 채널에서만, 명령어 제외
  if (message.guild && isAiChannelOrThread(message) && (!message.content || !message.content.startsWith(prefix))) {
    enqueueAiJob(String(message.guild.id), () => handleAiChat(message));
    return;
  }

  // 명령어 처리
  if (!message.content || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // AI 채널 인증
  if (command === '인증') {
    if (!message.guild) return;
    if (!message.member || !message.member.hasPermission('ADMINISTRATOR')) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }
    aiChannelByGuild.set(String(message.guild.id), String(message.channel.id));
    aiHistoryByChannel.set(String(message.guild.id) + ':' + String(message.channel.id), []);
    try { await message.reply('이 채널이 AI 대화 채널로 설정됐다.'); } catch (e) {}
    return;
  }

  if (command === '백업') {
    console.log('[Backup] command received by', message.author.tag);
    runBackup(message);
    return;
  }

  // PUBG 최신 패치노트 요약
  if (command === '배그패치') {
    try {
      await message.channel.send('배틀그라운드 최신 패치 노트를 가져오는 중...');
      const result = await fetchLatestPubgPatchNoteSummary();
      if (!result.ok) {
        await message.channel.send('패치 노트 정보를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }

      const embed = new Discord.MessageEmbed()
        .setTitle(result.title)
        .setURL(result.url)
        .setDescription(result.summary)
        .setTimestamp();

      if (result.imageUrl) {
        embed.setImage(result.imageUrl);
      }

      await message.channel.send(embed);
    } catch (e) {
      console.error('[배그패치] failed:', e && e.stack ? e.stack : e);
      try {
        await message.channel.send('패치 노트 정보를 가져오는 중 오류가 발생했습니다.');
      } catch (ee) {}
    }
    return;
  }

  // !복귀: 마지막 !해산으로 이동된 인원들을 대기실로 이동
  if (command === '복귀') {
    if (!message.guild) return;

    const waiting = message.guild.channels.cache.get(WAITING_ROOM_VOICE_ID);
    if (!waiting || waiting.type !== 'voice') {
      try { await message.reply('복귀 실패: 대기실 음성채널을 못 찾음.'); } catch (e) {}
      return;
    }

    if (lastDisbandedMemberIds.size === 0) {
      try { await message.reply('복귀할 대상이 없다.'); } catch (e) {}
      return;
    }

    let moved = 0;
    const ids = Array.from(lastDisbandedMemberIds);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const mem = message.guild.members.cache.get(String(id));
      if (!mem) continue;
      if (!mem.voice || !mem.voice.channel) continue;

      try {
        await mem.voice.setChannel(waiting);
        moved++;
      } catch (e) {
        console.error('[Return] move failed:', id, e && e.message ? e.message : e);
      }
    }

    lastDisbandedMemberIds.clear();
    try { await message.reply('복귀 완료: ' + moved + '명 대기실 이동'); } catch (e) {}
    return;
  }

  if (command === '팀') {
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) {
      return message.reply('올바른 인원 수를 입력해주세요.');
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('음성 채널에 들어가 주세요.');
    }

    const SPECTATOR_TAG = /\[관전\]/i;
    const members = voiceChannel.members
      .filter(m => {
        const name = m.displayName || m.user.username || '';
        return !m.user.bot && !SPECTATOR_TAG.test(name);
      })
      .array();

    if (members.length < n) {
      return message.reply('음성 채널에 인원이 부족합니다.');
    }

    // Fisher–Yates 셔플 사용
    const shuffledMembers = shuffleArray(members);

    const teams = [];
    let restMembers = shuffledMembers.length;

    while (restMembers > 0) {
      const teamSize = Math.min(restMembers, n);
      const startIndex = teams.length * n;
      const teamMembers = shuffledMembers.slice(startIndex, startIndex + teamSize);
      teams.push(teamMembers.map(member => member.displayName));
      restMembers -= teamSize;
    }

    latestTeams = teams;

    const selectedTeamIndex = Math.floor(Math.random() * teams.length);
    const selectedTeamName = (selectedTeamIndex + 1) + ' 팀';
    const randomMessage = selectedTeamName + '이 좀 치네...?';

    let teamMessage = '**새로운 팀이 구성되었습니다!**\n나와 함께 할 팀은???\n\n';
    teams.forEach((team, i) => {
      teamMessage += '```\nTeam ' + (i + 1) + '\n';
      team.forEach(name => {
        teamMessage += name + '\n';
      });
      teamMessage += '```\n';
    });

    message.channel.send(teamMessage);
    message.channel.send(randomMessage);
    return;
  }

  if (command === '해산') {
    if (latestTeams.length === 0) {
      return message.reply('먼저 !팀 명령어로 팀을 구성해주세요.');
    }

    // 순서대로 내전1부터 10까지 임
    const voiceChannelIds = [
      '1450857003521015921', '1450857559715217560', '1450857466312261786',
      '1450857664388005980', '1450857791789989971', '1450857978289983568',
      '1450858008027336844', '1450858203570110608', '1451547463554170930',
      '1451547521531773029'
    ];

    // 이번 해산 대상 저장 초기화
    lastDisbandedMemberIds.clear();

    latestTeams.forEach((team, i) => {
      const channelId = voiceChannelIds[i];
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== 'voice') return;

      team.forEach(name => {
        const member = message.guild.members.cache.find(m => m.displayName === name);
        if (member && member.voice.channel) {
          member.voice.setChannel(channel).then(() => {
            try { lastDisbandedMemberIds.add(String(member.id)); } catch (e) {}
          }).catch(err => {
            console.error('이동 실패:', member.displayName, err.message);
          });
        }
      });
    });

    message.channel.send('모든 인원을 이동 시켰습니다!!! @here');
    return;
  }

  if (command === '놀자') {
    const maxMembers = 4;

    if (!message.member.voice.channel) {
      return message.reply('먼저 음성 채널에 들어가주세요!');
    }

    const voice = message.member.voice.channel;

    const SPECTATOR_TAG = /\[관전\]/i;
    const effectiveMembers = voice.members.filter(m => {
      const name = m.displayName || m.user.username || '';
      return !m.user.bot && !SPECTATOR_TAG.test(name);
    });

    const currentMembers = effectiveMembers.size;
    const remainingMembers = Math.max(maxMembers - currentMembers, 0);

    const invite = await voice.createInvite({ maxAge: 3600 });

    const colors = ['#FF5733', '#C70039', '#900C3F', '#581845', '#2E86C1', '#2ECC71', '#F1C40F', '#8E44AD'];
    const selectedColor = colors[Math.floor(Math.random() * colors.length)];

    const inviteMessage = new Discord.MessageEmbed()
      .setTitle(voice.name + '\n' + remainingMembers + ' 명 구인 구직 중이에요')
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url + '\n@here');
    return;
  }

  if (command === '듀오') {
    const maxMembers = 2;

    if (!message.member.voice.channel) {
      return message.reply('먼저 음성 채널에 들어가주세요!');
    }

    const voice = message.member.voice.channel;

    const SPECTATOR_TAG = /\[관전\]/i;
    const effectiveMembers = voice.members.filter(m => {
      const name = m.displayName || m.user.username || '';
      return !m.user.bot && !SPECTATOR_TAG.test(name);
    });

    const currentMembers = effectiveMembers.size;
    const remainingMembers = Math.max(maxMembers - currentMembers, 0);

    const invite = await voice.createInvite({ maxAge: 3600 });

    const colors = ['#FF5733', '#C70039', '#900C3F', '#581845', '#2E86C1', '#2ECC71', '#F1C40F', '#8E44AD'];
    const selectedColor = colors[Math.floor(Math.random() * colors.length)];

    const inviteMessage = new Discord.MessageEmbed()
      .setTitle(voice.name + '\n듀오 구인 구직 중이에요\n' + remainingMembers + ' 명 더 필요해요')
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url + '\n@here');
    return;
  }

  if (message.content === '!명령어') {
    message.channel.send(
      '**구인구직 사용방법!**\n음성채널 생성 후 `!놀자` 입력하면 자동으로 초대링크 생성\n\n' +
      '**듀오 구인구직 사용방법!**\n음성채널 생성 후 `!듀오` 입력하면 듀오(2인) 초대링크 생성\n\n' +
      '**복귀 사용방법!**\n`!복귀` 입력하면 마지막 `!해산`으로 이동된 인원을 대기실로 이동\n\n' +
      '**팀 짜기 사용방법!**\n내전 대기실 입장 후 `!팀 N` (EX !팀 2 > 듀오씩) 입력 시 음성채널에 있는 인원을 N명만큼 팀 나눠집니다.\n[관전 적용된 인원은미포함]\n해당 봇 저작권은 도비에게 있습니다.'
    );
    return;
  }
});

// 메시지 수정 시: (캐시에 row가 있는 경우만) 외출목록 A~C 갱신
client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage) return;

    if (newMessage.partial) {
      try { newMessage = await newMessage.fetch(); } catch (e) { return; }
    }

    if (!newMessage.author || newMessage.author.bot) return;
    if (!isTargetChannelOrThread(newMessage)) return;

    console.log('[MSG_EDIT] recv', 'mid=' + newMessage.id, 'content=' + safeShort(newMessage.content, 140));
    enqueueSheetJob(() => updateLeaveRowFromEdit(newMessage));
  } catch (e) {
    console.error('[messageUpdate handler error]', e && e.stack ? e.stack : e);
  }
});

client.login(getEnv('DISCORD_TOKEN'));
