// index.js (discord.js v12.5.3 + Google Sheets logger for "카톡외출목록" + !백업 + !듀오 + Groq AI chat)
// Required Heroku Config Vars:
// - DISCORD_TOKEN
// - GOOGLE_SA_JSON_B64
// - GROQ_API_KEY

const Discord = require('discord.js');
const { google } = require('googleapis');
const https = require('https');

const client = new Discord.Client({
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});

const prefix = '!';
let latestTeams = [];

// ---- AI (Groq) Settings ----
const AI_DISABLED_MESSAGE = '현재 작동이 불가능 합니다';
const AI_NOT_OWNER_MESSAGE = '당신은 내 주인이 아냐 돌아가';

const AI_MAX_INPUT_CHARS = 600;
const AI_MAX_TOKENS = 256;
const AI_USER_COOLDOWN_MS = 8000;
const AI_TIMEOUT_MS = 20000;
const AI_MODEL = 'llama-3.1-8b-instant';

// 인증된 AI 채널 ID (!인증 명령으로 세팅됨)
// Heroku 재시작/배포 시 초기화됨(메모리 저장)
let aiChannelId = '';

// 주인 목록 (!주인 @태그 로 등록)
// Heroku 재시작/배포 시 초기화됨(메모리 저장)
const aiOwners = new Set();

// 주인 아닌 사람이 말 걸 때 스팸 방지(너무 많이 답장 안 하게)
const rejectCooldownMs = 5000;
const rejectLastByUser = new Map();

// ---- Google Sheets Settings ----
const TARGET_CHANNEL_ID = '1439239707320909895';

// UPDATED: Spreadsheet ID changed
const SPREADSHEET_ID = '1WzlRm6jlOGxTz4dTgbdMopzcJCNop8dnz7kP9GsMXZs';

// 외출 목록 기록 탭(실시간 기록용: 4컬럼)
const SHEET_TITLE_FIXED = '카톡외출목록';

// 백업 최대 메시지 수(안전장치)
const BACKUP_MAX_MESSAGES = 20000;

// sheet job serialize
let sheetQueue = Promise.resolve();
function enqueueSheetJob(fn) {
  sheetQueue = sheetQueue.then(fn).catch((err) => {
    console.error('[SheetJobError]', err && err.stack ? err.stack : err);
  });
  return sheetQueue;
}

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing env var: ' + name);
  return v;
}

function getEnvOptional(name) {
  const v = process.env[name];
  return v ? String(v) : '';
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

// message_id -> row number cache (실시간 기록용)
const msgRowCache = new Map();

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

// 실시간 외출목록: 4컬럼 (닉네임/사유/기간/등록시간)
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
  if (rowNum) msgRowCache.set(String(message.id), rowNum);

  console.log('[Leave][Append] ok', 'mid=' + message.id, 'row=' + (rowNum ? rowNum : 'unknown'));
}

// 메시지 수정 시(캐시에 row가 있는 경우만) A~C 업데이트
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

// ---------- Backup 기능 (3컬럼만 저장) ----------
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

// ---- AI (Groq) Helpers ----
const aiLastCallByUser = new Map();
const aiInFlightByUser = new Map();

function nowMs() {
  return new Date().getTime();
}

function clampPrompt(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= AI_MAX_INPUT_CHARS) return s;
  return s.slice(0, AI_MAX_INPUT_CHARS);
}

function splitDiscordMessage(text, maxLen) {
  const s = String(text || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

async function sendLongText(channel, text) {
  const chunks = splitDiscordMessage(text, 1900);
  for (let i = 0; i < chunks.length; i++) {
    await channel.send(chunks[i]);
  }
}

function groqRequestJson(payloadObj) {
  return new Promise((resolve, reject) => {
    const apiKey = getEnvOptional('GROQ_API_KEY');
    if (!apiKey) {
      const e = new Error('GROQ_API_KEY missing');
      e.statusCode = 0;
      return reject(e);
    }

    const payload = JSON.stringify(payloadObj);
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          const e = new Error('Groq HTTP ' + code);
          e.statusCode = code;
          e.body = data;
          return reject(e);
        }

        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          e.statusCode = code;
          e.body = data;
          reject(e);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(AI_TIMEOUT_MS, () => {
      try { req.destroy(new Error('timeout')); } catch (e) {}
    });

    req.write(payload);
    req.end();
  });
}

async function callGroqChat(prompt) {
  const p = clampPrompt(prompt);
  if (!p) return '';

  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: '너는 디스코드 채팅용 AI다. 한국어로 짧고 자연스럽게 답해라. 필요 이상으로 길게 말하지 마라.' },
      { role: 'user', content: p },
    ],
    temperature: 0.8,
    max_tokens: AI_MAX_TOKENS,
  };

  const json = await groqRequestJson(payload);

  const out =
    json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    typeof json.choices[0].message.content === 'string'
      ? json.choices[0].message.content
      : '';

  return String(out || '').trim();
}

function isAiOwner(userId) {
  return aiOwners.has(String(userId));
}

function shouldBlockAiForUser(userId) {
  const t = aiLastCallByUser.get(String(userId));
  if (!t) return false;
  return (nowMs() - t) < AI_USER_COOLDOWN_MS;
}

function markAiCall(userId) {
  aiLastCallByUser.set(String(userId), nowMs());
}

function isAiChannelOrThread(message) {
  if (!aiChannelId) return false;
  if (!message || !message.channel) return false;

  // 인증된 채널 자체
  if (String(message.channel.id) === String(aiChannelId)) return true;

  // 스레드라면 parentID가 인증 채널이면 허용
  if (message.channel.parentID && String(message.channel.parentID) === String(aiChannelId)) return true;

  return false;
}

function canManageAi(message) {
  if (!message || !message.guild || !message.member) return false;
  // 서버 오너 또는 관리자만
  const isGuildOwner = message.guild.ownerID && String(message.guild.ownerID) === String(message.author.id);
  const isAdmin = message.member.hasPermission && message.member.hasPermission('ADMINISTRATOR');
  return !!(isGuildOwner || isAdmin);
}

function canRejectNow(userId) {
  const last = rejectLastByUser.get(String(userId));
  if (!last) return true;
  return (nowMs() - last) >= rejectCooldownMs;
}

function markReject(userId) {
  rejectLastByUser.set(String(userId), nowMs());
}

async function handleAiMessage(message, promptText) {
  try {
    if (shouldBlockAiForUser(message.author.id)) return;

    if (aiInFlightByUser.get(String(message.author.id))) return;
    aiInFlightByUser.set(String(message.author.id), true);

    markAiCall(message.author.id);

    const answer = await callGroqChat(promptText);
    if (!answer) {
      await message.channel.send(AI_DISABLED_MESSAGE);
      return;
    }

    await sendLongText(message.channel, answer);
  } catch (e) {
    console.error('[AI] failed:', e && e.stack ? e.stack : e);
    try { await message.channel.send(AI_DISABLED_MESSAGE); } catch (ee) {}
  } finally {
    aiInFlightByUser.set(String(message.author.id), false);
  }
}

// ---- Global Error Logs ----
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

// ---- Discord Events ----
client.on('ready', async () => {
  console.log('[Bot] LoggedInAs:', client.user.tag);
  console.log('[Bot] TARGET_CHANNEL_ID:', TARGET_CHANNEL_ID);
  console.log('[Env] DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? 'SET' : 'MISSING');
  console.log('[Env] GOOGLE_SA_JSON_B64:', process.env.GOOGLE_SA_JSON_B64 ? 'SET' : 'MISSING');
  console.log('[Env] GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'SET' : 'MISSING');

  try {
    await initSheets();
  } catch (e) {
    console.error('[SheetsInitFailed]', e && e.stack ? e.stack : e);
  }
});

// 메시지 작성 시
client.on('message', async (message) => {
  if (!message || !message.author) return;
  if (message.author.bot) return;

  // 외출목록 기록
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

  // 인증된 AI 채널에서 "명령어 없이" 채팅하면 AI 응답 (주인만)
  if (isAiChannelOrThread(message)) {
    if (message.content && !message.content.startsWith(prefix)) {
      if (!isAiOwner(message.author.id)) {
        if (canRejectNow(message.author.id)) {
          markReject(message.author.id);
          try { await message.channel.send(AI_NOT_OWNER_MESSAGE); } catch (e) {}
        }
        return;
      }
      await handleAiMessage(message, message.content);
      return;
    }
  }

  // 커맨드 처리
  if (!message.content || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // AI 채널 인증: 이 명령을 친 채널이 AI 채널이 됨
  if (command === '인증') {
    if (!canManageAi(message)) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }

    // 스레드에서 실행하면 부모 채널을 인증 대상으로 잡음
    const targetId = message.channel.parentID ? String(message.channel.parentID) : String(message.channel.id);
    aiChannelId = targetId;

    try { await message.reply('AI 채널 인증 완료.'); } catch (e) {}
    return;
  }

  // 주인 등록: !주인 @태그
  if (command === '주인') {
    if (!canManageAi(message)) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }

    const mentions = message.mentions && message.mentions.users ? message.mentions.users : null;
    const first = mentions && mentions.first ? mentions.first() : null;
    if (!first) {
      try { await message.reply('사용법: !주인 @태그'); } catch (e) {}
      return;
    }

    aiOwners.add(String(first.id));
    try { await message.reply('주인 등록 완료.'); } catch (e) {}
    return;
  }

  // AI 명령어: !ai 질문
  if (command === 'ai') {
    if (!aiChannelId) {
      try { await message.reply('AI 채널이 아직 인증되지 않았다. 인증할 채널에서 !인증 을 먼저 해라.'); } catch (e) {}
      return;
    }

    // 인증된 채널에서만
    if (!isAiChannelOrThread(message)) {
      try { await message.reply('AI는 인증된 채널에서만 가능하다.'); } catch (e) {}
      return;
    }

    // 주인만
    if (!isAiOwner(message.author.id)) {
      try { await message.channel.send(AI_NOT_OWNER_MESSAGE); } catch (e) {}
      return;
    }

    const prompt = args.join(' ').trim();
    if (!prompt) {
      try { await message.reply('사용법: !ai 질문내용'); } catch (e) {}
      return;
    }

    await handleAiMessage(message, prompt);
    return;
  }

  if (command === '백업') {
    console.log('[Backup] command received by', message.author.tag);
    runBackup(message);
    return;
  }

  if (command === '팀') {
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) return message.reply('올바른 인원 수를 입력해주세요.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('음성 채널에 들어가 주세요.');

    const SPECTATOR_TAG = /\[관전\]/i;
    const members = voiceChannel.members
      .filter(m => {
        const name = m.displayName || m.user.username || '';
        return !m.user.bot && !SPECTATOR_TAG.test(name);
      })
      .array();

    if (members.length < n) return message.reply('음성 채널에 인원이 부족합니다.');

    const shuffledMembers = members.sort(() => Math.random() - 0.5);
    const teams = [];
    let restMembers = shuffledMembers.length;

    while (restMembers > 0) {
      const teamSize = Math.min(restMembers, n);
      const teamMembers = shuffledMembers.slice(teams.length * n, teams.length * n + teamSize);
      teams.push(teamMembers.map(member => member.displayName));
      restMembers -= teamSize;
    }

    latestTeams = teams;

    const selectedTeamIndex = Math.floor(Math.random() * teams.length);
    const selectedTeamName = `${selectedTeamIndex + 1} 팀`;
    const randomMessage = `${selectedTeamName}이 좀 치네...?`;

    let teamMessage = `**새로운 팀이 구성되었습니다!**\n나와 함께 할 팀은???\n\n`;
    teams.forEach((team, i) => {
      teamMessage += `\`\`\`\nTeam ${i + 1}\n`;
      team.forEach(name => { teamMessage += `${name}\n`; });
      teamMessage += `\`\`\`\n`;
    });

    message.channel.send(teamMessage);
    message.channel.send(randomMessage);
    return;
  }

  if (command === '해산') {
    if (latestTeams.length === 0) {
      return message.reply('먼저 !팀 명령어로 팀을 구성해주세요.');
    }

    const voiceChannelIds = [
      '1450857003521015921', '1450857559715217560', '1450857466312261786',
      '1450857664388005980', '1450857791789989971', '1450857978289983568',
      '1450858008027336844', '1450858203570110608', '1451547463554170930',
      '1451547521531773029'
    ];

    latestTeams.forEach((team, i) => {
      const channelId = voiceChannelIds[i];
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== 'voice') return;

      team.forEach(name => {
        const member = message.guild.members.cache.find(m => m.displayName === name);
        if (member && member.voice.channel) {
          member.voice.setChannel(channel).catch(err => {
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
      .setTitle(`:loud_sound: ${voice.name} 여기 왕따 있어요!!!! \n${remainingMembers} 명 구인 구직 중이에요`)
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url + "\n@here");
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
      .setTitle(`:loud_sound: ${voice.name} 듀오 구인 구직 중이에요 \n${remainingMembers} 명 더 필요해요`)
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url + "\n@here");
    return;
  }

  if (message.content === '!명령어') {
    message.channel.send(
      `**구인구직 사용방법!**\n음성채널 생성 후 \`\`!놀자\`\` 입력하면 자동으로 초대링크 생성\n\n` +
      `**듀오 구인구직 사용방법!**\n음성채널 생성 후 \`\`!듀오\`\` 입력하면 듀오(2인) 초대링크 생성\n\n` +
      `**팀 짜기 사용방법!**\n내전 대기실 입장 후 \`\`!팀 N\`\` (EX !팀 2 > 듀오씩) 입력 시 음성채널에 있는 인원을 N명만큼 팀 나눠집니다 !\n[관전 적용된 인원은미포함]\n\n` +
      `**AI 사용방법!**\nAI를 쓸 채널에서 관리자(또는 서버 오너)가 \`\`!인증\`\` 실행\n관리자(또는 서버 오너)가 \`\`!주인 @태그\`\` 로 주인 등록\n인증된 채널에서 주인만 일반 채팅 또는 \`\`!ai 질문\`\` 가능\n주인이 아니면: ` + AI_NOT_OWNER_MESSAGE + `\n` +
      `AI가 막히면: ` + AI_DISABLED_MESSAGE + `\n\n` +
      `해당 봇 저작권은 도비에게 있습니다. `
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
