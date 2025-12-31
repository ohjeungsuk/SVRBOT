const Discord = require('discord.js');
const { google } = require('googleapis');

const client = new Discord.Client({
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});

const prefix = '!';
let latestTeams = []; // !팀 명령으로 구성된 최신 팀 정보를 저장

// ---- Sheet Logger Settings ----
const TARGET_CHANNEL_ID = '1117136346075639888';
const SPREADSHEET_ID = '1aXIUb5yMA92s5EoYuyxf5IM8yFa_hryihUJDFIjsxyU';

// If you want to force a specific sheet tab name, set it here (optional).
// If null, the bot will use the first tab of the spreadsheet.
let SHEET_TITLE = null;

// message_id -> row number cache (clears when dyno restarts)
const msgRowCache = new Map();

// serialize sheet operations
let sheetQueue = Promise.resolve();
function enqueueSheetJob(fn) {
  sheetQueue = sheetQueue.then(fn).catch((err) => {
    console.error('SheetJobError:', err && err.message ? err.message : err);
  });
  return sheetQueue;
}

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing env var: ' + name);
  return v;
}

function parseServiceAccountFromB64() {
  const b64 = getEnv('GOOGLE_SA_JSON_B64');
  const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  const creds = JSON.parse(jsonStr);

  // private_key sometimes arrives with escaped newlines
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

function buildMessageLink(message) {
  const guildId = message.guild ? message.guild.id : '@me';
  return (
    'https://discord.com/channels/' +
    guildId +
    '/' +
    message.channel.id +
    '/' +
    message.id
  );
}

let sheetsApi = null;

async function initSheets() {
  if (sheetsApi && SHEET_TITLE) return;

  const creds = parseServiceAccountFromB64();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsApi = google.sheets({ version: 'v4', auth });

  if (!SHEET_TITLE) {
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheets = meta && meta.data && meta.data.sheets ? meta.data.sheets : [];
    if (!sheets.length || !sheets[0].properties || !sheets[0].properties.title) {
      throw new Error('Cannot resolve sheet title');
    }
    SHEET_TITLE = sheets[0].properties.title;
    console.log('SheetTitle:', SHEET_TITLE);
  }
}

function extractRowNumberFromUpdatedRange(updatedRange) {
  // example: "Sheet1!A12:H12"
  if (!updatedRange) return null;
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

async function appendMessageToSheet(message) {
  await initSheets();

  const createdAt = message.createdAt ? message.createdAt.toISOString() : '';
  const editedAt = message.editedAt ? message.editedAt.toISOString() : '';
  const author = message.author ? (message.author.tag || String(message.author)) : '';
  const authorId = message.author ? String(message.author.id) : '';

  const row = [
    createdAt,                               // created_at
    editedAt,                                // edited_at
    author,                                  // author
    authorId,                                // author_id
    String(message.channel.id),              // channel_id
    String(message.id),                      // message_id
    message.content ? String(message.content) : '', // content
    buildMessageLink(message),               // message_link
  ];

  const range = SHEET_TITLE + '!A:H';

  const res = await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  const updatedRange =
    res && res.data && res.data.updates ? res.data.updates.updatedRange : null;

  const rowNum = extractRowNumberFromUpdatedRange(updatedRange);
  if (rowNum) {
    msgRowCache.set(String(message.id), rowNum);
  }
}

async function findRowByMessageId(messageId) {
  await initSheets();

  const cached = msgRowCache.get(String(messageId));
  if (cached) return cached;

  // Search column F (message_id)
  const range = SHEET_TITLE + '!F:F';
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    majorDimension: 'COLUMNS',
  });

  const col =
    res && res.data && res.data.values && res.data.values[0] ? res.data.values[0] : [];

  for (let i = 0; i < col.length; i++) {
    if (String(col[i]) === String(messageId)) {
      const rowNum = i + 1; // 1-based
      msgRowCache.set(String(messageId), rowNum);
      return rowNum;
    }
  }
  return null;
}

async function updateEditedMessageInSheet(message) {
  await initSheets();

  const rowNum = await findRowByMessageId(message.id);
  if (!rowNum) return;

  const editedAt = message.editedAt
    ? message.editedAt.toISOString()
    : new Date().toISOString();

  const content = message.content ? String(message.content) : '';

  const data = [
    { range: SHEET_TITLE + '!B' + rowNum + ':B' + rowNum, values: [[editedAt]] }, // edited_at
    { range: SHEET_TITLE + '!G' + rowNum + ':G' + rowNum, values: [[content]] },  // content
  ];

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: data,
    },
  });
}

// ---- Discord Events ----
client.on('ready', async () => {
  console.log('LoggedInAs:', client.user.tag);

  try {
    await initSheets();
  } catch (e) {
    console.error('SheetsInitFailed:', e && e.message ? e.message : e);
  }
});

client.on('message', async (message) => {
  if (!message || !message.author) return;
  if (message.author.bot) return;

  // Always log messages in the target channel
  if (String(message.channel.id) === TARGET_CHANNEL_ID) {
    enqueueSheetJob(() => appendMessageToSheet(message));
  }

  // Commands
  if (!message.content || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // !팀 명령어
  if (command === '팀') {
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) return message.reply('올바른 인원 수를 입력해주세요.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('음성 채널에 들어가 주세요.');

    const SPECTATOR_TAG = /\[관전\]/i;

    // 봇, 관전 태그만 제외 (마이크 mute 조건 제거)
    const members = voiceChannel.members
      .filter((m) => {
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
      teams.push(teamMembers.map((member) => member.displayName));
      restMembers -= teamSize;
    }

    latestTeams = teams;

    const selectedTeamIndex = Math.floor(Math.random() * teams.length);
    const selectedTeamName = (selectedTeamIndex + 1) + ' 팀';
    const randomMessage = selectedTeamName + '이 좀 치네...?';

    let teamMessage = '**새로운 팀이 구성되었습니다!**\n나와 함께 할 팀은???\n\n';
    teams.forEach((team, i) => {
      teamMessage += '```\nTeam ' + (i + 1) + '\n';
      team.forEach((name) => {
        teamMessage += name + '\n';
      });
      teamMessage += '```\n';
    });

    message.channel.send(teamMessage);
    message.channel.send(randomMessage);
    return;
  }

  // !해산 명령어 - 팀원 강제 이동
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

    latestTeams.forEach((team, i) => {
      const channelId = voiceChannelIds[i];
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== 'voice') return;

      team.forEach((name) => {
        const member = message.guild.members.cache.find((m) => m.displayName === name);
        if (member && member.voice.channel) {
          member.voice.setChannel(channel).catch((err) => {
            console.error('MoveFailed:', member.displayName, err.message);
          });
        }
      });
    });

    message.channel.send('모든 인원을 이동 시켰습니다!!! @here');
    return;
  }

  // !놀자 명령어
  if (command === '놀자') {
    const maxMembers = 4;

    if (!message.member.voice.channel) {
      return message.reply('먼저 음성 채널에 들어가주세요!');
    }

    const voice = message.member.voice.channel;

    // 닉네임/서버닉네임에 [관전] 포함된 멤버 제거, 봇도 제외
    const SPECTATOR_TAG = /\[관전\]/i;
    const effectiveMembers = voice.members.filter((m) => {
      const name = m.displayName || m.user.username || '';
      return !m.user.bot && !SPECTATOR_TAG.test(name);
    });

    const currentMembers = effectiveMembers.size;
    const remainingMembers = Math.max(maxMembers - currentMembers, 0);

    // 초대 링크 생성 (1시간)
    const invite = await voice.createInvite({ maxAge: 3600 });

    const colors = ['#FF5733', '#C70039', '#900C3F', '#581845', '#2E86C1', '#2ECC71', '#F1C40F', '#8E44AD'];
    const selectedColor = colors[Math.floor(Math.random() * colors.length)];

    const inviteMessage = new Discord.MessageEmbed()
      .setTitle(':loud_sound: ' + voice.name + ' 여기 왕따 있어요!!!! \n' + remainingMembers + ' 명 구인 구직 중이에요')
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url);
    return;
  }

  // !명령어
  if (message.content === '!명령어') {
    message.channel.send(
      '**구인구직 사용방법!**\n음성채널 생성 후 ``!놀자`` 입력하면 자동으로 초대링크 생성\n\n' +
      '**팀 짜기 사용방법!**\n내전 대기실 입장 후 ``!팀 N`` (EX !팀 2 > 듀오씩) 입력 시 음성채널에 있는 인원을 N명만큼 팀 나눠집니다 !\n[관전 적용된 인원은미포함] \n 해당 봇 저작권은 도비에게 있습니다. '
    );
    return;
  }
});

// message edit -> update edited_at + content in sheet
client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage) return;

    if (newMessage.partial) {
      try {
        newMessage = await newMessage.fetch();
      } catch (e) {
        return;
      }
    }

    if (!newMessage.author || newMessage.author.bot) return;
    if (String(newMessage.channel.id) !== TARGET_CHANNEL_ID) return;

    enqueueSheetJob(() => updateEditedMessageInSheet(newMessage));
  } catch (e) {
    console.error('MessageUpdateError:', e && e.message ? e.message : e);
  }
});

process.on('unhandledRejection', (err) => {
  console.error('UnhandledRejection:', err && err.message ? err.message : err);
});

client.login(getEnv('DISCORD_TOKEN'));
