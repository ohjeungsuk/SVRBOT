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
const zlib = require('zlib');

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
// NOTE:
// PUBG 사이트는 일부 페이지가 CSR(클라이언트 렌더링) 기반이라, 목록 HTML에 <a href="..."> 가 없거나,
// 링크가 script/데이터 속성 안에만 존재하는 경우가 있습니다.
// 그래서 아래 구현은 href 뿐 아니라, HTML 전체에서 /news/<id> 패턴을 폭넓게 탐색하고(컨텍스트 점수 기반),
// 필요 시 여러 목록 URL을 순차적으로 시도합니다.

const PUBG_PATCH_LIST_URL = 'https://pubg.com/ko/news?category=patch_notes&label=label_pc';

// fallback 목록 URL (상황에 따라 리다이렉트/차단/지역 분기 존재)
const PUBG_PATCH_LIST_URLS = [
  'https://pubg.com/ko/news?category=patch_notes&label=label_pc',
  'https://pubg.com/ko/news?category=patch_notes',
  'https://pubg.com/en/news?category=patch_notes&label=label_pc',
  'https://pubg.com/en/news?category=patch_notes',
  'https://pubg.com/news?category=patch_notes&label=label_pc',
  'https://pubg.com/news?category=patch_notes',
  'https://www.pubg.com/ko/news?category=patch_notes&label=label_pc',
  'https://www.pubg.com/ko/news?category=patch_notes',
  'https://www.pubg.com/en/news?category=patch_notes&label=label_pc',
  'https://www.pubg.com/en/news?category=patch_notes',
];

const PUBG_HTTP_TIMEOUT_MS = 25000;
const PUBG_MAX_HTML_BYTES = 6 * 1024 * 1024; // 6MB
const PUBG_CACHE_TTL_MS = 10 * 60 * 1000;    // 10 minutes
const PUBG_DEFAULT_EXCERPT_CHARS = 4500;
const PUBG_FULL_EXCERPT_CHARS = 15000;

// Optional debug (Heroku Config Vars): PUBG_DEBUG=1
const PUBG_DEBUG = String(process.env.PUBG_DEBUG || '') === '1';

const pubgPatchCache = {
  url: '',
  fetchedAtMs: 0,
  data: null,
};

function pubgLog() {
  if (!PUBG_DEBUG) return;
  try { console.log.apply(console, arguments); } catch (e) {}
}

function decodeHtmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function resolveUrl(base, href) {
  try {
    return new URL(String(href), String(base)).toString();
  } catch (e) {
    return String(href || '');
  }
}

function gunzipIfNeeded(buf, encoding, cb) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'gzip') {
    zlib.gunzip(buf, cb);
    return;
  }
  if (enc === 'deflate') {
    zlib.inflate(buf, cb);
    return;
  }
  if (enc === 'br') {
    if (zlib.brotliDecompress) {
      zlib.brotliDecompress(buf, cb);
      return;
    }
  }
  cb(null, buf);
}

function fetchHtml(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const maxRedirects = 5;

    function go(u, redirectsLeft) {
      const req = https.request(
        u,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
            'Referer': 'https://pubg.com/',
          },
          timeout: timeoutMs || PUBG_HTTP_TIMEOUT_MS,
        },
        (res) => {
          if (!res) {
            reject(new Error('no response'));
            return;
          }

          // Redirect
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location && redirectsLeft > 0) {
            const nextUrl = resolveUrl(u, res.headers.location);
            res.resume();
            go(nextUrl, redirectsLeft - 1);
            return;
          }

          const chunks = [];
          let total = 0;

          res.on('data', (chunk) => {
            if (!chunk) return;
            total += chunk.length || 0;
            if (total > PUBG_MAX_HTML_BYTES) {
              try { req.destroy(new Error('response too large')); } catch (e) {}
              return;
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const enc = res.headers ? res.headers['content-encoding'] : '';
            gunzipIfNeeded(buf, enc, (err, outBuf) => {
              if (err) {
                reject(err);
                return;
              }
              const html = outBuf.toString('utf8');
              const status = res.statusCode || 0;
              resolve({ ok: (status >= 200 && status < 400), url: u, statusCode: status, html: html });
            });
          });

          res.on('error', (e) => reject(e));
        }
      );

      req.on('timeout', () => {
        try { req.destroy(new Error('timeout')); } catch (e) {}
        reject(new Error('timeout'));
      });

      req.on('error', (e) => reject(e));
      req.end();
    }

    go(String(url), maxRedirects);
  });
}

function extractMetaContent(html, key, val) {
  if (!html) return '';
  const re = new RegExp('<meta[^>]+\\b' + escapeRegex(String(key)) + '\\s*=\\s*["\\\']' + escapeRegex(String(val)) + '["\\\'][^>]*>', 'i');
  const m = String(html).match(re);
  if (!m) return '';
  const tag = m[0];
  const m2 = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
  if (!m2) return '';
  return decodeHtmlEntities(String(m2[1] || '')).trim();
}

function stripTagsToText(html) {
  if (!html) return '';
  let s = String(html);

  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // line breaks
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p\s*>/gi, '\n\n');
  s = s.replace(/<\/h[1-6]\s*>/gi, '\n\n');
  s = s.replace(/<\/div\s*>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<\/li\s*>/gi, '\n');

  // remove tags
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeHtmlEntities(s);

  // normalize whitespace
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

function tryParseJsonSafe(s) {
  try { return JSON.parse(String(s || '')); } catch (e) { return null; }
}

function extractAllLdJsonObjects(html) {
  const out = [];
  if (!html) return out;

  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const raw = String(m[1] || '').trim();
    if (!raw) continue;
    const obj = tryParseJsonSafe(raw);
    if (!obj) continue;

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) out.push(obj[i]);
    } else {
      out.push(obj);
    }
  }
  return out;
}

function extractLdJsonBody(html) {
  const objs = extractAllLdJsonObjects(html);
  let best = '';
  let bestScore = -1;

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;

    const body = (typeof o.articleBody === 'string') ? o.articleBody : '';
    if (!body || body.length < 200) continue;

    const sc = scorePatchTextCandidate(body);
    if (sc > bestScore) {
      bestScore = sc;
      best = body;
    }
  }
  return best;
}

function extractNextDataJson(html) {
  if (!html) return null;

  const m = String(html).match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m || !m[1]) return null;

  const raw = String(m[1] || '').trim();
  if (!raw) return null;

  return tryParseJsonSafe(raw);
}

function countHangulChars(s) {
  const m = String(s || '').match(/[가-힣]/g);
  return m ? m.length : 0;
}

function upperIndexOf(hay, needle) {
  return String(hay || '').toUpperCase().indexOf(String(needle || '').toUpperCase());
}

function scorePatchTextCandidate(raw) {
  if (!raw) return -1;
  const s0 = String(raw);
  if (s0.length < 200) return -1;

  // Convert to plain text for scoring
  let plain = s0;
  if (/<[^>]+>/.test(plain)) plain = stripTagsToText(plain);
  else plain = decodeHtmlEntities(plain);

  plain = String(plain || '').trim();
  if (plain.length < 200) return -1;

  const len = plain.length;
  const hangul = countHangulChars(plain);
  const ratio = hangul / Math.max(1, len);

  // Strong negative signals (footer/menu)
  const badTokens = [
    'LEARN MORE PUBG', 'PLAY NOW', 'ENGLISH (GLOBAL)', 'GAME INFO', 'COMMUNITY', 'SUPPORT',
    'Epic Games', 'PlayStation', 'Steam', 'XBOX', 'MEDIA', 'KRAFTON', 'KRAFTON ID',
  ];

  let badHits = 0;
  for (let i = 0; i < badTokens.length; i++) {
    if (upperIndexOf(plain, badTokens[i]) >= 0) badHits++;
  }

  // Positive signals (patch note words)
  const goodTokens = [
    '패치', '패치노트', '업데이트', '변경', '개선', '수정', '버그', '밸런스', '신규', '추가',
    '무기', '차량', '맵', '전장', '아이템', '모드', '경쟁전', '서바이버', '리콜',
  ];

  let goodHits = 0;
  for (let j = 0; j < goodTokens.length; j++) {
    if (plain.indexOf(goodTokens[j]) >= 0) goodHits++;
  }

  // Heading / list structure
  const headings = (plain.match(/\n\s*#{1,6}\s+/g) || []).length +
                   (plain.match(/\n\s*[0-9]+\./g) || []).length;
  const bullets = (plain.match(/\n\s*[-*•]\s+/g) || []).length;

  // Base score = length, then add signals
  let score = len;

  // Language preference
  if (ratio < 0.02) score -= 5000; // likely not Korean or not article body
  else if (ratio > 0.05) score += 1500;

  score += goodHits * 700;
  score += headings * 250;
  score += bullets * 120;
  score -= badHits * 1500;

  return score;
}

function findBestPatchBodyFromJson(root) {
  if (!root) return '';

  const stack = [root];
  let bestRaw = '';
  let bestScore = -1;
  let iter = 0;

  while (stack.length > 0 && iter < 200000) {
    iter++;
    const v = stack.pop();
    if (!v) continue;

    if (typeof v === 'string') {
      const s = String(v);
      if (s.length < 200) continue;

      const sc = scorePatchTextCandidate(s);
      if (sc > bestScore) {
        bestScore = sc;
        bestRaw = s;
      }
      continue;
    }

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
      continue;
    }

    if (typeof v === 'object') {
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        // Prefer typical body keys a bit by pushing them last (so popped earlier)
        const val = v[k];
        stack.push(val);
      }
      continue;
    }
  }

  return bestRaw;
}

function trimFooterLikeText(text) {
  let t = String(text || '').trim();
  if (!t) return '';

  const markers = [
    'LEARN MORE PUBG',
    'ENGLISH (GLOBAL)',
    'PLAY NOW',
    'GAME INFO',
    'COMMUNITY',
    'SUPPORT - Steam',
    'SUPPORT',
    'Epic Games',
    'PlayStation',
    'XBOX',
    'MEDIA',
  ];

  let cut = -1;
  const upper = t.toUpperCase();
  for (let i = 0; i < markers.length; i++) {
    const idx = upper.indexOf(String(markers[i]).toUpperCase());
    if (idx >= 0 && idx > 400) {
      if (cut < 0 || idx < cut) cut = idx;
    }
  }

  if (cut > 0) t = t.slice(0, cut);

  // normalize whitespace
  t = t.replace(/\r/g, '');
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function collectUrlsFromJson(root, mode, maxCount) {
  const out = [];
  if (!root) return out;

  const isImage = (mode === 'image');
  const isVideo = (mode === 'video');

  const reImg = /^https?:\/\/[^\s"'<>]+\.(png|jpe?g|webp|gif)(\?[^\s"'<>]*)?$/i;
  const reVid = /^(https?:\/\/[^\s"'<>]+\.(mp4|webm)(\?[^\s"'<>]*)?|https?:\/\/[^\s"'<>]*(youtube\.com|youtu\.be|vimeo\.com)[^\s"'<>]*)$/i;

  function isBadMediaUrl(u) {
    const s = String(u || '').toLowerCase();
    if (s.indexOf('kraf') >= 0 && s.indexOf('wstatic') < 0) return true;
    if (s.indexOf('krafton') >= 0 && s.indexOf('wstatic') < 0) return true;
    if (s.indexOf('krafonid') >= 0) return true;
    if (s.indexOf('login') >= 0) return true;
    if (s.indexOf('favicon') >= 0) return true;
    if (s.indexOf('logo') >= 0) return true;
    if (s.indexOf('sprite') >= 0) return true;
    return false;
  }

  const stack = [root];
  let iter = 0;

  while (stack.length > 0 && out.length < (maxCount || 10) && iter < 200000) {
    iter++;
    const v = stack.pop();
    if (!v) continue;

    if (typeof v === 'string') {
      const s = String(v).trim();
      if (!s) continue;
      if (s.indexOf('http') !== 0) continue;

      if (isImage && reImg.test(s) && !isBadMediaUrl(s)) uniquePush(out, s);
      else if (isVideo && reVid.test(s) && !isBadMediaUrl(s)) uniquePush(out, s);
      continue;
    }

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
      continue;
    }

    if (typeof v === 'object') {
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) stack.push(v[keys[i]]);
      continue;
    }
  }

  return out;
}

function isProbablyPatchBodyText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length < 800) return false;

  const hangul = countHangulChars(t);
  if (hangul < 200) return false;

  if (t.indexOf('업데이트') >= 0) return true;
  if (t.indexOf('패치') >= 0) return true;
  if (t.indexOf('패치 노트') >= 0) return true;

  // weak fallback: lots of list items / headings
  const bullets = (t.match(/\n\s*[-*•]\s+/g) || []).length;
  const headings = (t.match(/\n\s*#{1,6}\s+/g) || []).length;
  if (bullets >= 8 || headings >= 3) return true;

  return false;
}


function uniquePush(arr, v) {
  const s = String(v || '').trim();
  if (!s) return;
  if (arr.indexOf(s) >= 0) return;
  arr.push(s);
}

function detectLocaleFromUrl(u) {
  try {
    const p = new URL(String(u)).pathname.split('/').filter(Boolean);
    if (p.length > 0 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(p[0])) return String(p[0]).toLowerCase();
  } catch (e) {}
  return '';
}

// PUBG 뉴스는 최근 /news/9635 처럼 3~7자리 숫자 ID를 사용한다.
// 8자리(YYYYMMDD) 형태는 구형/다른 페이지에서 섞여 들어오는 경우가 있어 패치노트 후보에서 제외한다.
function parseNewsIdFromUrl(u) {
  const s = String(u || '');
  const m = s.match(/\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?news\/(\d{3,7})(?:[/?#]|$)/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? 0 : n;
}

function normalizeNewsUrlToLocale(absUrl, baseUrl) {
  try {
    const bu = new URL(String(baseUrl));
    const au = new URL(String(absUrl));
    const locale = detectLocaleFromUrl(bu.toString()) || 'ko';

    // origin 통일(리다이렉트/서브도메인 섞임 방지)
    au.protocol = bu.protocol;
    au.host = bu.host;

    // /news/ID  -> /{locale}/news/ID
    if (/^\/news\/\d{3,7}(?:[/?#]|$)/i.test(au.pathname)) {
      au.pathname = '/' + locale + au.pathname;
      return au.toString();
    }

    // /xx/news/ID -> locale로 강제
    const m = au.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\/news\/(\d{3,7})(?:[/?#]|$)/i);
    if (m) {
      const id = m[2];
      au.pathname = '/' + locale + '/news/' + id;
      return au.toString();
    }

    return au.toString();
  } catch (e) {
    return String(absUrl || '');
  }
}

function buildNewsUrlForId(baseUrl, id) {
  try {
    const bu = new URL(String(baseUrl));
    const locale = detectLocaleFromUrl(bu.toString()) || 'ko';
    const n = parseInt(String(id), 10);
    if (isNaN(n)) return '';
    return bu.origin + '/' + locale + '/news/' + String(n);
  } catch (e) {
    return '';
  }
}

function collectPatchNewsObjectsFromNextData(nextObj, limit) {
  const out = [];
  const seen = {};

  function add(id, title, category, label, dateStr) {
    const n = parseInt(String(id), 10);
    if (isNaN(n)) return;
    const idLen = String(n).length;
    if (idLen >= 8) return; // YYYYMMDD 차단
    if (idLen < 3 || idLen > 7) return;
    if (seen[n]) return;
    seen[n] = 1;

    const t = String(title || '');
    const c = String(category || '');
    const l = String(label || '');
    const d = String(dateStr || '');

    const tLower = t.toLowerCase();
    const cLower = c.toLowerCase();
    const lLower = l.toLowerCase();

    let score = 0;
    if (cLower.indexOf('patch') >= 0 || cLower.indexOf('patch_notes') >= 0) score += 60;
    if (tLower.indexOf('patch') >= 0 || t.indexOf('패치') >= 0) score += 50;
    if (t.indexOf('업데이트') >= 0 || tLower.indexOf('update') >= 0) score += 20;
    if (lLower.indexOf('pc') >= 0 || lLower.indexOf('label_pc') >= 0) score += 10;
    if (d) score += 2;

    out.push({ id: n, title: t, category: c, label: l, date: d, score: score });
  }

  const stack = [nextObj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
      continue;
    }

    const t = typeof cur;
    if (t === 'object') {
      try {
        const id = cur.id || cur.newsId || cur.postId || cur.articleId;
        const title = cur.title || cur.name || cur.subject;
        const category = cur.category || cur.categoryName || cur.categoryCode || cur.category_code;
        const label = cur.label || cur.labelCode || cur.tag || cur.platform || cur.device;
        const dateStr = cur.publishDate || cur.publishedAt || cur.createdAt || cur.date;

        if (id && title) {
          const titleStr = String(title);
          const catStr = String(category || '');
          if (titleStr.indexOf('패치') >= 0 || titleStr.indexOf('업데이트') >= 0 || titleStr.toLowerCase().indexOf('patch') >= 0 || catStr.toLowerCase().indexOf('patch') >= 0) {
            add(id, titleStr, catStr, label, dateStr);
          }
        }
      } catch (e) {}

      const keys = Object.keys(cur);
      for (let i = 0; i < keys.length; i++) {
        try { stack.push(cur[keys[i]]); } catch (e) {}
      }

      if (limit && out.length >= limit) break;
      continue;
    }

    if (t === 'string') {
      // ignore
      continue;
    }
  }

  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (limit && out.length > limit) return out.slice(0, limit);
  return out;
}


function scoreByContext(html, idx) {
  if (!html || idx == null) return 0;
  const s = String(html);
  const from = Math.max(0, idx - 500);
  const to = Math.min(s.length, idx + 500);
  const seg = s.slice(from, to).toLowerCase();

  let score = 0;

  // patch notes 키워드
  if (seg.indexOf('patch notes') >= 0) score += 30;
  if (seg.indexOf('patch_notes') >= 0) score += 30;
  if (seg.indexOf('패치 노트') >= 0) score += 30;

  // pc/label
  if (seg.indexOf('label_pc') >= 0) score += 15;

  // console/labs 등은 살짝 감점
  if (seg.indexOf('console') >= 0) score -= 4;
  if (seg.indexOf('labs') >= 0) score -= 2;

  return score;
}

function pushCandidate(out, url, baseUrl, html, idx) {
  if (!url) return;

  const raw = String(url).trim();
  if (!raw) return;

  // 목록 페이지 쿼리 자체는 제외(예: ?category=patch_notes&...)
  if (raw.indexOf('?') >= 0) return;

  if (raw.indexOf('/news/') < 0) return;

  let abs = resolveUrl(baseUrl, raw);
  if (!abs) return;

  // locale(/ko, /en 등) 강제 + origin 통일
  abs = normalizeNewsUrlToLocale(abs, baseUrl);

  // media 직접 링크 제외
  if (/\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i.test(abs)) return;

  const id = parseNewsIdFromUrl(abs);
  if (!id) return;

  const score = scoreByContext(html, idx);

  // id 기준 중복 제거(서브도메인/로케일 차이로 URL이 달라도 동일 글)
  for (let i = 0; i < out.length; i++) {
    if (out[i] && out[i].id === id) {
      if (score > out[i].score) {
        out[i].url = abs;
        out[i].score = score;
      }
      return;
    }
  }

  out.push({ url: abs, id: id, score: score });
}


function extractCandidateNewsUrlsFromHtml(listHtml, baseUrl) {
  const out = [];
  if (!listHtml) return out;

  const html = String(listHtml);

  // 1) href 기반
  const reHref = /\bhref\s*=\s*["']([^"']+)["']/ig;
  let m;
  while ((m = reHref.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;

    // news 관련만
    if (String(href).indexOf('/news/') < 0) continue;
    // 목록 페이지 쿼리 자체는 제외
    if (String(href).indexOf('/news?') >= 0) continue;

    pushCandidate(out, href, baseUrl, html, m.index);
    if (out.length >= 40) break;
  }

  // 2) data-* / onclick 기반
  const reData = /\b(?:data-href|data-url|data-link|data-to)\s*=\s*["']([^"']+)["']/ig;
  while ((m = reData.exec(html)) !== null) {
    const v = m[1];
    if (!v) continue;
    if (String(v).indexOf('/news/') < 0) continue;
    pushCandidate(out, v, baseUrl, html, m.index);
    if (out.length >= 40) break;
  }

  const reOnClick = /\bonclick\s*=\s*["'][^"']*(\/[a-z]{2}(?:-[a-z]{2})?\/news\/\d{3,7}[^"']*)["']/ig;
  while ((m = reOnClick.exec(html)) !== null) {
    const v2 = m[1];
    if (!v2) continue;
    pushCandidate(out, v2, baseUrl, html, m.index);
    if (out.length >= 40) break;
  }
  // 2.5) __NEXT_DATA__ JSON 스캔: 리스트 HTML에 href가 없고 ID만 들어있는 경우 대비
  try {
    const nextObj = extractNextDataJson(listHtml);
    if (nextObj) {
      // (a) 문자열 중 /news/#### 경로 추출
      const stack = [nextObj];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;

        if (Array.isArray(cur)) {
          for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
          continue;
        }

        const t = typeof cur;
        if (t === 'string') {
          const s = cur;
          if (s.indexOf('/news/') >= 0) {
            const rePath = /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?news\/\d{3,7}(?:[/?#]|$)/ig;
            let mm;
            while ((mm = rePath.exec(s)) != null) {
              pushCandidate(out, mm[0], baseUrl, listHtml, 0);
            }
          }
          continue;
        }

        if (t === 'object') {
          const keys = Object.keys(cur);
          for (let i = 0; i < keys.length; i++) {
            try { stack.push(cur[keys[i]]); } catch (e) {}
          }
          continue;
        }
      }

      // (b) 오브젝트 후보 수집 -> id로 URL 생성
      const objCandidates = collectPatchNewsObjectsFromNextData(nextObj, 20);
      for (let i = 0; i < objCandidates.length; i++) {
        const c = objCandidates[i];
        const u = buildNewsUrlForId(baseUrl, c.id);
        if (!u) continue;
        pushCandidate(out, u, baseUrl, listHtml, 0);
        if (out.length >= 30) break;
      }
    }
  } catch (e) {}


  // 3) HTML 전체에서 /<locale>/news/<id> 패턴 스캔 (script 포함)
  const reLocalePath = /\/[a-z]{2}(?:-[a-z]{2})?\/news\/\d{3,7}(?:\?[^"'\s<]*)?/ig;
  while ((m = reLocalePath.exec(html)) !== null) {
    pushCandidate(out, m[0], baseUrl, html, m.index);
    if (out.length >= 60) break;
  }

  // 4) /news/<id> 패턴 스캔 (locale 없는 케이스)
  const rePlainPath = /\/news\/\d{3,7}(?:\?[^"'\s<]*)?/ig;
  while ((m = rePlainPath.exec(html)) !== null) {
    pushCandidate(out, m[0], baseUrl, html, m.index);
    if (out.length >= 80) break;
  }

  // 5) 절대 URL 패턴 스캔
  const reAbs = /https?:\/\/(?:www\.)?pubg\.com\/[a-z]{2}(?:-[a-z]{2})?\/news\/\d{3,7}(?:\?[^"'\s<]*)?/ig;
  while ((m = reAbs.exec(html)) !== null) {
    pushCandidate(out, m[0], baseUrl, html, m.index);
    if (out.length >= 80) break;
  }

  return out;
}

function pickBestCandidate(candidates) {
  if (!candidates || candidates.length === 0) return null;

  // score 우선, 그 다음 id(대부분 최신일수록 증가)
  candidates.sort((a, b) => {
    const sa = a && typeof a.score === 'number' ? a.score : 0;
    const sb = b && typeof b.score === 'number' ? b.score : 0;
    if (sb !== sa) return sb - sa;

    const ia = a && typeof a.id === 'number' ? a.id : 0;
    const ib = b && typeof b.id === 'number' ? b.id : 0;
    return ib - ia;
  });

  return candidates[0];
}

function extractUrlsByTagAttr(html, tagName, attrName, baseUrl, maxCount) {
  const out = [];
  if (!html) return out;

  const re = new RegExp('<' + escapeRegex(tagName) + '\\b[^>]*\\b' + escapeRegex(attrName) + '\\s*=\\s*["\\\']([^"\\\']+)["\\\']', 'ig');
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const href = m[1];
    const abs = resolveUrl(baseUrl, href);
    if (abs.indexOf('data:') === 0) continue;
    if (abs.toLowerCase().indexOf('.svg') >= 0) continue;
    uniquePush(out, abs);
    if (maxCount && out.length >= maxCount) break;
  }
  return out;
}

function parsePatchNoteFromArticle(html, finalUrl) {
  const baseUrl = finalUrl || 'https://pubg.com/ko/news';

  const title =
    extractMetaContent(html, 'property', 'og:title') ||
    extractMetaContent(html, 'name', 'twitter:title') ||
    (function () {
      const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return m ? decodeHtmlEntities(String(m[1] || '').replace(/\s+/g, ' ').trim()) : '';
    })();

  const imageUrl =
    extractMetaContent(html, 'property', 'og:image') ||
    extractMetaContent(html, 'name', 'twitter:image') ||
    '';

  const ogVideo =
    extractMetaContent(html, 'property', 'og:video') ||
    extractMetaContent(html, 'property', 'og:video:url') ||
    extractMetaContent(html, 'name', 'twitter:player') ||
    '';

  const published =
    extractMetaContent(html, 'property', 'article:published_time') ||
    extractMetaContent(html, 'name', 'pubdate') ||
    extractMetaContent(html, 'name', 'publish-date') ||
    extractMetaContent(html, 'name', 'date') ||
    '';

  // Try to isolate <article> first
  let articleHtml = '';
  const mArticle = String(html || '').match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (mArticle && mArticle[1]) {
    articleHtml = mArticle[1];
  } else {
    const mMain = String(html || '').match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mMain && mMain[1]) articleHtml = mMain[1];
    else articleHtml = String(html || '');
  }

  // Candidate bodies:
  const ldBody = extractLdJsonBody(html);
  const nextObj = extractNextDataJson(html);
  const nextBodyRaw = nextObj ? findBestPatchBodyFromJson(nextObj) : '';

  let bestRaw = '';
  let bestScore = -1;

  function consider(raw) {
    if (!raw) return;
    const sc = scorePatchTextCandidate(raw);
    if (sc > bestScore) {
      bestScore = sc;
      bestRaw = raw;
    }
  }

  consider(nextBodyRaw);
  consider(ldBody);
  consider(articleHtml);

  // Convert chosen raw to text
  let contentText = '';
  if (bestRaw) {
    if (/<[^>]+>/.test(bestRaw)) contentText = stripTagsToText(bestRaw);
    else contentText = decodeHtmlEntities(bestRaw);
  }

  if (!contentText) contentText = stripTagsToText(articleHtml);
  contentText = trimFooterLikeText(contentText);

  // If still looks wrong, fallback to full html stripped
  if (!isProbablyPatchBodyText(contentText)) {
    const fallback = trimFooterLikeText(stripTagsToText(String(html || '')));
    if (isProbablyPatchBodyText(fallback)) contentText = fallback;
  }

  function isBadMediaUrlLocal(u) {
    const s = String(u || '').toLowerCase();
    if (s.indexOf('krafonid') >= 0) return true;
    if (s.indexOf('krafton') >= 0 && s.indexOf('wstatic') < 0) return true;
    if (s.indexOf('login') >= 0) return true;
    if (s.indexOf('logo') >= 0) return true;
    if (s.indexOf('sprite') >= 0) return true;
    if (s.indexOf('favicon') >= 0) return true;
    return false;
  }

  // Collect media
  const imageUrls = [];
  const bodyImg = extractUrlsByTagAttr(articleHtml, 'img', 'src', baseUrl, 10);
  for (let i = 0; i < bodyImg.length; i++) {
    if (!isBadMediaUrlLocal(bodyImg[i])) uniquePush(imageUrls, bodyImg[i]);
  }

  const bodyImg2 = extractUrlsByTagAttr(articleHtml, 'img', 'data-src', baseUrl, 10);
  for (let i = 0; i < bodyImg2.length; i++) {
    if (!isBadMediaUrlLocal(bodyImg2[i])) uniquePush(imageUrls, bodyImg2[i]);
  }

  // From Next.js JSON (often contains the real media urls)
  if (nextObj) {
    const jimgs = collectUrlsFromJson(nextObj, 'image', 12);
    for (let i = 0; i < jimgs.length; i++) {
      if (!isBadMediaUrlLocal(jimgs[i])) uniquePush(imageUrls, jimgs[i]);
    }
  }

  if (imageUrl) {
    const abs = resolveUrl(baseUrl, imageUrl);
    if (!isBadMediaUrlLocal(abs)) uniquePush(imageUrls, abs);
  }

  const videoUrls = [];
  if (ogVideo) uniquePush(videoUrls, resolveUrl(baseUrl, ogVideo));

  const ifr = extractUrlsByTagAttr(articleHtml, 'iframe', 'src', baseUrl, 6);
  for (let i = 0; i < ifr.length; i++) {
    if (!isBadMediaUrlLocal(ifr[i])) uniquePush(videoUrls, ifr[i]);
  }

  const vid = extractUrlsByTagAttr(articleHtml, 'video', 'src', baseUrl, 6);
  for (let i = 0; i < vid.length; i++) {
    if (!isBadMediaUrlLocal(vid[i])) uniquePush(videoUrls, vid[i]);
  }

  if (nextObj) {
    const jvids = collectUrlsFromJson(nextObj, 'video', 6);
    for (let i = 0; i < jvids.length; i++) {
      if (!isBadMediaUrlLocal(jvids[i])) uniquePush(videoUrls, jvids[i]);
    }
  }

  return {
    title: title,
    url: String(finalUrl || ''),
    imageUrl: imageUrl ? resolveUrl(baseUrl, imageUrl) : '',
    publishedText: published,
    contentText: contentText,
    imageUrls: imageUrls,
    videoUrls: videoUrls,
  };
}

async function fetchLatestPubgPatchNote(options) {
  const opt = options || {};
  const wantChars = opt.maxChars && !isNaN(opt.maxChars) ? parseInt(opt.maxChars, 10) : PUBG_DEFAULT_EXCERPT_CHARS;

  // cache
  const now = nowMs();
  if (pubgPatchCache.data && pubgPatchCache.fetchedAtMs && (now - pubgPatchCache.fetchedAtMs) < PUBG_CACHE_TTL_MS) {
    const cached = pubgPatchCache.data;
    if (cached && cached.url) {
      pubgLog('cache_hit url=' + cached.url);
      return cached;
    }
  }

  let listHtml = '';
  let listFinalUrl = '';
  let candidates = [];
  let lastListError = null;

  for (let i = 0; i < PUBG_PATCH_LIST_URLS.length; i++) {
    const u = PUBG_PATCH_LIST_URLS[i];
    try {
      pubgLog('fetch_list try url=' + u);
      const listRes = await fetchHtml(u, PUBG_HTTP_TIMEOUT_MS);
      if (!listRes || !listRes.ok) throw new Error('list fetch failed');

      listHtml = listRes.html || '';
      listFinalUrl = listRes.url || u;

      candidates = extractCandidateNewsUrlsFromHtml(listHtml, listFinalUrl);
      pubgLog('list_candidates count=' + (candidates ? candidates.length : 0));

      if (candidates && candidates.length > 0) break;
    } catch (e) {
      lastListError = e;
      pubgLog('fetch_list failed url=' + u + ' err=' + (e && e.message ? e.message : e));
    }
  }

  if (!candidates || candidates.length === 0) {
    if (lastListError) throw lastListError;
    throw new Error('PUBG patch link not found');
  }

  // Sort candidates (by score/id)
  pickBestCandidate(candidates); // sorts in-place (side effect)

  const TRY_MAX = Math.min(candidates.length, 6);
  let chosenParsed = null;
  let chosenUrl = '';
  let chosenResUrl = '';
  let lastErr = null;

  for (let i = 0; i < TRY_MAX; i++) {
    const c = candidates[i];
    if (!c || !c.url) continue;

    pubgLog('try_candidate[' + i + '] url=' + c.url + ' score=' + c.score + ' id=' + c.id);

    try {
      const articleRes = await fetchHtml(c.url, PUBG_HTTP_TIMEOUT_MS);
      if (!articleRes || !articleRes.ok) throw new Error('PUBG article fetch failed');

      const parsed = parsePatchNoteFromArticle(articleRes.html || '', articleRes.url || c.url);
      const bodyText = String(parsed.contentText || '').trim();

      if (isProbablyPatchBodyText(bodyText)) {
        chosenParsed = parsed;
        chosenUrl = String(parsed.url || c.url);
        chosenResUrl = String(articleRes.url || c.url);
        pubgLog('candidate_ok url=' + chosenUrl + ' finalUrl=' + chosenResUrl + ' textLen=' + bodyText.length);
        break;
      }

      lastErr = new Error('candidate not patch body');
      pubgLog('candidate_skip reason=not_patch_body textLen=' + bodyText.length);
    } catch (e) {
      lastErr = e;
      pubgLog('candidate_fail err=' + (e && e.message ? e.message : e));
    }
  }

  if (!chosenParsed) {
    if (lastErr) throw lastErr;
    throw new Error('PUBG patch content not found');
  }

  const contentText = String(chosenParsed.contentText || '').trim();

  // excerpt
  let excerpt = contentText;
  if (wantChars > 0 && excerpt.length > wantChars) {
    excerpt = excerpt.slice(0, wantChars) + '\n\n(이하 생략)';
  }

  const out = {
    title: chosenParsed.title,
    url: chosenUrl,
    publishedText: chosenParsed.publishedText,
    imageUrl: chosenParsed.imageUrl,
    imageUrls: chosenParsed.imageUrls || [],
    videoUrls: chosenParsed.videoUrls || [],
    contentText: contentText,
    excerptText: excerpt,
  };

  pubgPatchCache.url = out.url;
  pubgPatchCache.fetchedAtMs = nowMs();
  pubgPatchCache.data = out;

  pubgLog('cache_set url=' + out.url + ' title=' + safeShort(out.title, 80) + ' textLen=' + out.contentText.length);

  return out;
}

async function fetchLatestPubgPatchNoteSummary(options) {
  const opt = options || {};
  const wantFull = opt && opt.full === true;
  const maxChars = wantFull ? PUBG_FULL_EXCERPT_CHARS : PUBG_DEFAULT_EXCERPT_CHARS;

  const data = await fetchLatestPubgPatchNote({ maxChars: maxChars });

  // Summary via AI (if available). Use only a slice to limit cost.
  const rawText = String(data.contentText || '').trim();
  const forAi = rawText.length > 3500 ? rawText.slice(0, 3500) : rawText;

  let summaryText = '';
  if (OPENAI_API_KEY) {
    const instructionText =
      '너는 게임 패치노트 요약 봇이다. ' +
      '반드시 한국어로만 답한다. ' +
      '원문에 있는 내용만 요약한다. 추측하지 않는다. ' +
      '핵심만 정리한다. ' +
      '불릿 5~10개로 요약한다. ' +
      '패치 항목이 많으면 섹션별로 묶는다.';

    const prompt =
      '아래는 배틀그라운드(PUBG) 패치노트 원문 일부다.\n' +
      '다음 규칙으로 요약해라:\n' +
      '- 중요한 변경점 우선\n' +
      '- 수치/밸런스/버그수정/신규콘텐츠 구분\n' +
      '- 애매하면 원문 그대로 쓰지 말고 짧게 표현\n\n' +
      forAi;

    const aiResult = await callOpenAIResponses(instructionText, prompt);
    if (aiResult && aiResult.ok && aiResult.text) summaryText = String(aiResult.text || '').trim();
  }

  if (!summaryText) {
    // fallback: 짧은 발췌
    const fallback = rawText.length > 800 ? rawText.slice(0, 800) + '...' : rawText;
    summaryText = fallback || '요약 실패';
  }

  return {
    title: data.title,
    url: data.url,
    listUrl: data.listUrl || PUBG_PATCH_LIST_URL,
    publishedText: data.publishedText,
    imageUrl: data.imageUrl,
    imageUrls: data.imageUrls,
    videoUrls: data.videoUrls,
    summary: summaryText,
    excerptText: data.excerptText,
    contentText: data.contentText,
  };
}

// ---- End PUBG Patch Notes Helper Functions ----

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
    // 사용법:
    // !배그패치            : 요약 + 본문 일부(기본)
    // !배그패치 원문       : 원문 기반으로 본문 더 길게
    // !배그패치 전체       : 가능한 범위 내에서 더 길게(최대 15000자)
    const mode = args && args.length > 0 ? String(args[0] || '').trim() : '';
    const wantRaw = (mode === '원문');
    const wantFull = (mode === '전체');

    try {
      const info = await fetchLatestPubgPatchNoteSummary({ full: wantFull || wantRaw });

      const embed = new Discord.MessageEmbed()
        .setTitle(info.title || 'PUBG 최신 패치노트')
        .setURL(info.url || PUBG_PATCH_LIST_URL)
        .setColor('#2ecc71')
        .setTimestamp();

      if (info.publishedText) {
        embed.addField('게시일', safeShort(info.publishedText, 100), false);
      }

      if (info.summary) {
        embed.addField('요약', safeShort(info.summary, 1000), false);
      }

      // 이미지: embed에는 1개만 넣고, 추가 이미지 링크는 별도 안내
      const img1 = (info.imageUrls && info.imageUrls.length > 0) ? info.imageUrls[0] : (info.imageUrl || '');
      if (img1) embed.setImage(img1);

      // 영상/추가 이미지 링크
      const videos = (info.videoUrls && info.videoUrls.length > 0) ? info.videoUrls.slice(0, 2) : [];
      const images = (info.imageUrls && info.imageUrls.length > 1) ? info.imageUrls.slice(1, 4) : [];

      if (videos.length > 0) {
        embed.addField('영상', safeShort(videos.join('\n'), 1000), false);
      }
      if (images.length > 0) {
        embed.addField('추가 이미지', safeShort(images.join('\n'), 1000), false);
      }

      await message.channel.send(embed);

      // 본문 출력(링크 말고 내용)
      // 기본: excerptText (4500자). 원문/전체: 더 길게. Discord 제한 때문에 자동으로 끊는다.
      let body = '';
      if (wantRaw || wantFull) body = String(info.contentText || '').trim();
      else body = String(info.excerptText || '').trim();

      if (!body) {
        await message.channel.send('패치노트 본문을 추출하지 못했다. 링크로 확인해줘: ' + (info.url || PUBG_PATCH_LIST_URL));
        return;
      }

      // 너무 길면 잘라서 전송(과부화/스팸 방지)
      const hardCap = wantFull ? PUBG_FULL_EXCERPT_CHARS : (wantRaw ? PUBG_FULL_EXCERPT_CHARS : PUBG_DEFAULT_EXCERPT_CHARS);
      if (body.length > hardCap) {
        body = body.slice(0, hardCap) + '\n\n(이하 생략)';
      }

      // 메시지 분할 전송 + 최대 메시지수 제한
      const LIMIT = 1900;
      const MAX_MSGS = wantFull ? 10 : 6;
      let sent = 0;
      let idx = 0;

      while (idx < body.length && sent < MAX_MSGS) {
        const chunk = body.slice(idx, idx + LIMIT);
        idx += LIMIT;
        await message.channel.send(chunk);
        sent++;
      }

      if (idx < body.length) {
        await message.channel.send('(본문이 너무 길어서 일부만 보냈다. 더 보려면 !배그패치 전체)');
      }

      return;
    } catch (e) {
      console.error('[PUBG_PATCH_ERROR]', e && e.stack ? e.stack : e);
      await message.reply('배그 패치노트 가져오기 실패. 잠시 후 다시 시도해줘.');
      return;
    }
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
