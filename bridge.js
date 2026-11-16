require('./logger').install({ service: 'bridge' });
const { throttled } = require('./logger');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const sharp = require('sharp');
require('dotenv').config();

const app = express();
const PORT = process.env.BRIDGE_PORT || 3005;

// ---------- MAPEAMENTO USUÁRIO → TELEFONE ----------
const USER_MAP_FILE = path.join(__dirname, 'user_phone_map.json');
let userPhoneMap = {};
let ultimoConteudoMapa = null;

function loadUserMap() {
    try {
        if (fs.existsSync(USER_MAP_FILE)) {
            const raw = fs.readFileSync(USER_MAP_FILE, 'utf8');
            userPhoneMap = JSON.parse(raw);
            if (raw !== ultimoConteudoMapa) {
                console.log(`📞 Mapeamento de usuários ${ultimoConteudoMapa === null ? 'carregado' : 'ATUALIZADO'}: ${Object.keys(userPhoneMap).length} entradas (${USER_MAP_FILE})`);
                ultimoConteudoMapa = raw;
            }
        } else {
            userPhoneMap = {};
            console.log('⚠️ Arquivo de mapeamento não encontrado, usando vazio.');
        }
    } catch (e) {
        console.error('❌ Erro ao carregar mapeamento:', e.message);
        userPhoneMap = {};
    }
}

loadUserMap();
setInterval(loadUserMap, 5 * 60 * 1000);

// ---------- CONFIGURAÇÕES JELLYFIN ----------
const DEFAULT_JELLYFIN_URL = 'http://127.0.0.1:8096';
const JELLYFIN_URL = (process.env.JELLYFIN_URL || DEFAULT_JELLYFIN_URL).replace(/\/+$/, '');
const PUBLIC_JELLYFIN_URL = (process.env.PUBLIC_JELLYFIN_URL || JELLYFIN_URL).replace(/\/+$/, '');
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
const JELLYFIN_SERVER_ID = process.env.JELLYFIN_SERVER_ID || ''; // <-- NOVO
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// ---------- WEBHOOK: LIBERAR NOTIFICAÇÃO PARA USUÁRIO NOVO (ex.: 1º login via Google) ----------
const WEBHOOK_PLUGIN_ID = process.env.WEBHOOK_PLUGIN_ID || '71552a5a-5c5c-4350-a2ae-ebe451a30173';
const USER_FILTER_SYNC_MINUTES = parseInt(process.env.USER_FILTER_SYNC_MINUTES, 10) || 3;
const KNOWN_USERS_FILE = path.join(__dirname, 'known_jellyfin_users.json');

console.log(`🔧 JELLYFIN_URL (interna): ${JELLYFIN_URL}`);
console.log(`🌐 PUBLIC_JELLYFIN_URL (links): ${PUBLIC_JELLYFIN_URL}`);
console.log(`🆔 JELLYFIN_SERVER_ID: ${JELLYFIN_SERVER_ID || '(não definido)'}`);
if (TMDB_API_KEY) console.log('🎬 TMDB_API_KEY configurada');
else console.log('⚠️ TMDB_API_KEY não configurada');

// ---------- INTERAÇÃO PARA SOLICITANTE ----------
// Desligada por padrão: sob o PM2 ninguém responde à pergunta no terminal e o aviso do filme ficava
// preso na fila para sempre. Com ENABLE_SOLICITANTE_INPUT=true volta a perguntar "Quem pediu este filme?".
const ENABLE_SOLICITANTE_INPUT = process.env.ENABLE_SOLICITANTE_INPUT === 'true';
const rl = ENABLE_SOLICITANTE_INPUT
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
let pendingItems = [];
let isProcessingPending = false;

function getPhoneForUser(username) {
    if (!username) return null;
    return userPhoneMap[username] || null;
}

async function processPendingItem() {
    if (isProcessingPending || pendingItems.length === 0 || !ENABLE_SOLICITANTE_INPUT) return;
    isProcessingPending = true;
    const pending = pendingItems.shift();
    const { item, captionBase, itemId, serverUrl, numbers } = pending;

    rl.question(
        `\n🎬 Novo filme adicionado: "${item.Name}" (${item.Year || ''})\nQuem pediu este filme? (digite o nome ou Enter para pular): `,
        (answer) => {
            const solicitante = answer.trim() || null;
            let finalCaption = captionBase;
            if (solicitante) {
                finalCaption += `\n👤 Solicitado por: ${solicitante}`;
            }

            const envios = numbers.map((num) =>
                enviarParaNumero(num, finalCaption, itemId, serverUrl, item)
            );

            Promise.allSettled(envios)
                .then(() => {
                    console.log(`✅ Mensagem com solicitante enviada para ${numbers.length} destinatário(s)`);
                })
                .catch((err) => {
                    console.error('❌ Erro ao enviar mensagem com solicitante:', err);
                })
                .finally(() => {
                    isProcessingPending = false;
                    processPendingItem();
                });
        }
    );
}

function enqueueItemAdded(item, captionBase, itemId, serverUrl, numbers) {
    if (!ENABLE_SOLICITANTE_INPUT || numbers.length === 0) {
        numbers.forEach((num) => enviarParaNumero(num, captionBase, itemId, serverUrl, item));
        return;
    }
    pendingItems.push({ item, captionBase, itemId, serverUrl, numbers });
    if (!isProcessingPending) {
        processPendingItem();
    }
}

// Agente HTTPS ignorando certificados autoassinados
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Caches
const userCache = new Map();
const sentMessagesCache = new Map();
const itemInfoCache = new Map();

// Fila de retry para ATSAPP
const retryQueue = [];
let retryProcessing = false;

async function processRetryQueue() {
    if (retryProcessing || retryQueue.length === 0) return;
    retryProcessing = true;

    while (retryQueue.length > 0) {
        const { numero, mensagem, itemId, serverUrl, item, tentativas } = retryQueue.shift();
        console.log(`🔄 Reenviando para ${numero} (tentativa ${tentativas}/5)`);
        const success = await enviarParaNumero(numero, mensagem, itemId, serverUrl, item, false);
        if (!success && tentativas < 5) {
            const nextDelay = 60000 * tentativas;
            console.log(`⏳ Agendando nova tentativa em ${nextDelay/1000}s para ${numero}`);
            retryQueue.push({ numero, mensagem, itemId, serverUrl, item, tentativas: tentativas + 1 });
            setTimeout(processRetryQueue, nextDelay);
            break;
        } else if (!success) {
            console.log(`❌ Falha definitiva ao enviar para ${numero} após 5 tentativas.`);
        } else {
            console.log(`✅ Reenvio bem-sucedido para ${numero}`);
        }
    }
    retryProcessing = false;
}

// ---------- MIDDLEWARES ----------
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.use((req, res, next) => {
    if (!req.body || req.body.length === 0) {
        req.body = {};
        return next();
    }

    let raw = req.body.toString('utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    try {
        req.body = JSON.parse(raw);
        req.contentType = 'json';
        return next();
    } catch (e) {
        req.rawString = raw;
        next();
    }
});

app.use(express.urlencoded({ extended: true, verify: (req, res, buf) => { req.rawUrlencoded = buf; } }));

app.use((req, res, next) => {
    if (req.body && Object.keys(req.body).length > 0) return next();
    if (req.rawString) {
        const params = new URLSearchParams(req.rawString);
        if ([...params.keys()].length > 0) {
            req.body = Object.fromEntries(params);
            req.contentType = 'form';
        } else {
            req.body = { _rawText: req.rawString };
            req.contentType = 'text';
        }
    }
    next();
});

// ---------- CONFIGURAÇÕES DO WHATSAPP ----------
const JELLYFIN_WHATSAPP_GROUP = process.env.JELLYFIN_WHATSAPP_GROUP || '';
const WHATSAPP_NUMBERS = JELLYFIN_WHATSAPP_GROUP
    ? [JELLYFIN_WHATSAPP_GROUP]
    : (process.env.WHATSAPP_NUMBERS || '')
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0);

const JELLYFIN_TODOS_GROUP = process.env.JELLYFIN_TODOS_GROUP || '';

const ATSAPP_API_URL = (process.env.ATSAPP_API_URL || 'http://localhost:8082').replace(/\/+$/, '');
const SISTEMA_MOBILE_URL = 'http://localhost:3004';
const SONARR_URL = (process.env.SONARR_URL || '').replace(/\/+$/, '');
const SONARR_API_KEY = process.env.SONARR_API_KEY || '';
const SONARR_PUBLIC_URL = (process.env.SONARR_PUBLIC_URL || SONARR_URL).replace(/\/+$/, '');
const SONARR_WHATSAPP_GROUP = process.env.SONARR_WHATSAPP_GROUP || '';
const SONARR_WHATSAPP_NUMBERS = SONARR_WHATSAPP_GROUP
    ? [SONARR_WHATSAPP_GROUP]
    : (process.env.SONARR_WHATSAPP_NUMBERS || '')
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0);
const SONARR_RECIPIENTS = SONARR_WHATSAPP_NUMBERS.length > 0 ? SONARR_WHATSAPP_NUMBERS : WHATSAPP_NUMBERS;
const SONARR_REMINDER_MINUTES_BEFORE = parsePositiveInt(process.env.SONARR_REMINDER_MINUTES_BEFORE, 30);
const SONARR_POLL_INTERVAL_MINUTES = parsePositiveInt(process.env.SONARR_POLL_INTERVAL_MINUTES, 5);
const SONARR_LOOKAHEAD_MINUTES = parsePositiveInt(
    process.env.SONARR_LOOKAHEAD_MINUTES,
    SONARR_REMINDER_MINUTES_BEFORE + SONARR_POLL_INTERVAL_MINUTES + 5
);
const SONARR_STATE_FILE = process.env.SONARR_STATE_FILE || path.join(__dirname, 'sonarr-reminder-state.json');
const REMINDER_STATE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// ---------- FILTRO DE REPRODUÇÃO (pedido do usuário 27/10/2026) ----------
// WhatsApp avisa 1 vez por filme/episódio que o usuário inicia: o Jellyfin dispara PlaybackStart a cada
// início/retomada/stop→play, e PlaybackStop anunciava a parada. Janela de deduplicação: PLAYBACK_TTL_HORAS
// (padrão 18h), salvo em playback-announce-state.json para sobreviver a reinícios do bridge.
const PLAYBACK_STATE_FILE = process.env.PLAYBACK_STATE_FILE || path.join(__dirname, 'playback-announce-state.json');
const PLAYBACK_TTL_HORAS = parsePositiveInt(process.env.PLAYBACK_TTL_HORAS, 18);
const SESSION_COOLDOWN_SEGUNDOS = parsePositiveInt(process.env.SESSION_COOLDOWN_SEGUNDOS, 3600);
let sonarrReminderState = loadSonarrReminderState();
let sonarrPollingStarted = false;
let sonarrPollInFlight = false;

console.log(`📞 Destinatários WhatsApp: ${WHATSAPP_NUMBERS.join(', ') || 'nenhum'}`);
console.log(`🌐 API do bot ATSAPP: ${ATSAPP_API_URL}`);

// ---------- FUNÇÕES AUXILIARES ----------
function formatRuntime(runtimeTicksOrString) {
    if (!runtimeTicksOrString) return null;
    if (typeof runtimeTicksOrString === 'string' && runtimeTicksOrString.match(/[0-9]+[smh]/)) {
        return runtimeTicksOrString;
    }
    const totalSeconds = Math.floor(runtimeTicksOrString / 10000000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadSonarrReminderState() {
    try {
        if (!fs.existsSync(SONARR_STATE_FILE)) {
            return { sent: {} };
        }
        const raw = fs.readFileSync(SONARR_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? { sent: parsed.sent || {} } : { sent: {} };
    } catch (err) {
        console.error(`⚠️ Falha ao ler estado do Sonarr: ${err.message}`);
        return { sent: {} };
    }
}

function saveSonarrReminderState() {
    try {
        fs.writeFileSync(SONARR_STATE_FILE, JSON.stringify(sonarrReminderState, null, 2));
    } catch (err) {
        console.error(`⚠️ Falha ao salvar estado do Sonarr: ${err.message}`);
    }
}

function pruneSonarrReminderState(now = Date.now()) {
    let changed = false;
    const sent = sonarrReminderState.sent || {};
    for (const [key, value] of Object.entries(sent)) {
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp) || now - timestamp > REMINDER_STATE_RETENTION_MS) {
            delete sent[key];
            changed = true;
        }
    }
    if (changed) {
        sonarrReminderState.sent = sent;
        saveSonarrReminderState();
    }
}

function getSonarrEpisodeKey(episode) {
    const episodeId = episode.id || episode.episodeFileId || `${episode.seriesId || episode.series?.id || episode.series?.title}-${episode.seasonNumber}-${episode.episodeNumber}`;
    return `${episodeId}:${episode.airDateUtc}:${SONARR_REMINDER_MINUTES_BEFORE}`;
}

function formatSonarrDateTime(dateLike) {
    const date = new Date(dateLike);
    return new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: process.env.TZ || 'America/Sao_Paulo'
    }).format(date);
}

function formatSonarrTime(dateLike) {
    const date = new Date(dateLike);
    return new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: process.env.TZ || 'America/Sao_Paulo'
    }).format(date);
}

function getMinutesUntil(dateLike, now = new Date()) {
    return (new Date(dateLike).getTime() - now.getTime()) / 60000;
}

function buildSonarrEpisodeCode(episode) {
    const season = Number(episode.seasonNumber || 0).toString().padStart(2, '0');
    const episodeNumber = Number(episode.episodeNumber || 0).toString().padStart(2, '0');
    return `T${season}E${episodeNumber}`;
}

function buildSonarrReminderMessage(episode) {
    const seriesTitle = episode.series?.title || episode.seriesTitle || 'Série monitorada';
    const episodeCode = buildSonarrEpisodeCode(episode);
    const episodeTitle = episode.title || 'Título não informado';
    const formattedDate = formatSonarrDateTime(episode.airDateUtc);
    const formattedTime = formatSonarrTime(episode.airDateUtc);
    const linkBase = SONARR_PUBLIC_URL || '';

    let message = `📅 *Lembrete de estreia de episódio inédito no streaming/tv americana*\n\n`;
    message += `📺 *${seriesTitle}*\n`;
    message += `🎞️ ${episodeCode}: ${episodeTitle}\n`;
    message += `🕒 Irá estrear às ${formattedTime}\n`;
    message += `📆 Data/Hora: ${formattedDate}\n`;
    message += `⏳ Faltam apenas ${SONARR_REMINDER_MINUTES_BEFORE} minutos.`;

    if (linkBase && episode.seriesId) {
        message += `\n🔗 Lembrando que apenas em algumas horas já estará disponível aqui no Jellyflix: ${PUBLIC_JELLYFIN_URL}/web/#/home`;
    }

    return message;
}

async function fetchSonarrCalendar(now = new Date()) {
    if (!SONARR_URL || !SONARR_API_KEY) {
        return [];
    }

    const start = new Date(now.getTime());
    const end = new Date(now.getTime() + SONARR_LOOKAHEAD_MINUTES * 60000);
    const url = `${SONARR_URL}/api/v3/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&includeSeries=true&unmonitored=false`;
    const response = await fetchWithRetry(url, {
        headers: { 'X-Api-Key': SONARR_API_KEY }
    }, 2, 1500);

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Sonarr respondeu ${response.status}${errorText ? ` - ${errorText}` : ''}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

function shouldSendSonarrReminder(episode, now = new Date()) {
    if (!episode || !episode.airDateUtc) return false;
    if (episode.monitored === false) return false;
    if (episode.series?.monitored === false) return false;
    if (episode.hasFile === true || episode.episodeFileId) return false;

    const minutesUntil = getMinutesUntil(episode.airDateUtc, now);
    const lowerBound = SONARR_REMINDER_MINUTES_BEFORE - SONARR_POLL_INTERVAL_MINUTES;
    const upperBound = SONARR_REMINDER_MINUTES_BEFORE + Math.max(2, Math.ceil(SONARR_POLL_INTERVAL_MINUTES / 2));

    return minutesUntil > lowerBound && minutesUntil <= upperBound;
}

async function processSonarrReminders(options = {}) {
    const { dryRun = false, trigger = 'manual' } = options;

    if (!SONARR_URL || !SONARR_API_KEY) {
        return {
            enabled: false,
            trigger,
            reason: 'SONARR_URL ou SONARR_API_KEY não configurados'
        };
    }

    if (SONARR_RECIPIENTS.length === 0) {
        return {
            enabled: false,
            trigger,
            reason: 'Nenhum destinatário configurado para os lembretes do Sonarr'
        };
    }

    if (sonarrPollInFlight && !dryRun) {
        return {
            enabled: true,
            trigger,
            skipped: true,
            reason: 'Uma varredura do Sonarr já está em andamento'
        };
    }

    const now = new Date();
    sonarrPollInFlight = !dryRun;

    try {
        pruneSonarrReminderState(now.getTime());
        const episodes = await fetchSonarrCalendar(now);
        const candidates = episodes
            .filter(episode => shouldSendSonarrReminder(episode, now))
            .sort((a, b) => new Date(a.airDateUtc) - new Date(b.airDateUtc));

        const result = {
            enabled: true,
            trigger,
            scanned: episodes.length,
            candidates: candidates.length,
            sent: 0,
            skipped: 0,
            previews: []
        };

        for (const episode of candidates) {
            const reminderKey = getSonarrEpisodeKey(episode);
            if (sonarrReminderState.sent?.[reminderKey]) {
                result.skipped += 1;
                continue;
            }

            const message = buildSonarrReminderMessage(episode);
            result.previews.push({
                seriesTitle: episode.series?.title || episode.seriesTitle || null,
                episodeTitle: episode.title || null,
                airDateUtc: episode.airDateUtc,
                message
            });

            if (dryRun) {
                continue;
            }

            const sendResults = await Promise.allSettled(
                SONARR_RECIPIENTS.map(numero => enviarParaNumero(numero, message))
            );

            const delivered = sendResults.filter(item => item.status === 'fulfilled' && item.value === true).length;
            if (delivered > 0) {
                sonarrReminderState.sent[reminderKey] = now.toISOString();
                saveSonarrReminderState();
                result.sent += 1;
                // 13/10/2026: o lembrete também é falado na Echo (o Home Assistant decide horário silencioso etc.)
                if (ECHO_MIDIA_ATIVA) {
                    const serie = tituloMidiaParaFala(episode.series?.title || episode.seriesTitle || 'uma série');
                    const ep = Number.isFinite(Number(episode.episodeNumber)) ? `o episódio ${episode.episodeNumber} de ` : '';
                    falarMidiaNaEcho('Sonarr', `lembra que daqui a ${SONARR_REMINDER_MINUTES_BEFORE} minutos estreia ${ep}${serie}.`)
                        .catch((e) => console.error(`❌ [Echo] Lembrete de estreia não falado: ${e.message}`));
                }
            }
        }

        return result;
    } finally {
        sonarrPollInFlight = false;
    }
}

function startSonarrReminderScheduler() {
    if (sonarrPollingStarted) return;
    sonarrPollingStarted = true;

    if (!SONARR_URL || !SONARR_API_KEY) {
        console.log('⚠️ Lembretes do Sonarr desativados: configure SONARR_URL e SONARR_API_KEY.');
        return;
    }

    if (SONARR_RECIPIENTS.length === 0) {
        console.log('⚠️ Lembretes do Sonarr desativados: configure WHATSAPP_NUMBERS ou SONARR_WHATSAPP_NUMBERS.');
        return;
    }

    console.log(`📅 Lembretes do Sonarr ativos: ${SONARR_REMINDER_MINUTES_BEFORE} min antes da estreia.`);
    console.log(`🔄 Varredura do calendário Sonarr a cada ${SONARR_POLL_INTERVAL_MINUTES} minuto(s).`);
    console.log(`📞 Destinatários Sonarr: ${SONARR_RECIPIENTS.join(', ')}`);
    console.log(`💾 Estado persistido em: ${SONARR_STATE_FILE}`);

    setTimeout(() => {
        processSonarrReminders({ trigger: 'startup' })
            .then(result => console.log(`✅ Varredura inicial do Sonarr: ${result.sent || 0} lembrete(s) enviados.`))
            .catch(err => console.error('❌ Erro na varredura inicial do Sonarr:', err.message));
    }, 10000);

    setInterval(() => {
        processSonarrReminders({ trigger: 'interval' })
            .then(result => {
                if ((result.sent || 0) > 0) {
                    console.log(`✅ Lembretes Sonarr enviados nesta rodada: ${result.sent}`);
                }
            })
            .catch(err => console.error('❌ Erro ao processar lembretes do Sonarr:', err.message));
    }, SONARR_POLL_INTERVAL_MINUTES * 60 * 1000);
}

// ---------- SINCRONIZAÇÃO: NOVO USUÁRIO JELLYFIN → FILTRO DO PLUGIN WEBHOOK ----------
// Quando alguém loga pela 1ª vez (ex.: via Google SSO), o Jellyfin cria um usuário novo,
// mas o plugin Webhook só notifica quem já está no "UserFilter" de cada destino.
// Esta rotina detecta usuários novos e adiciona o Id deles em todos os GenericOptions,
// liberando a notificação de reprodução para o bridge.js sem intervenção manual.
let knownUserIds = new Set();

function loadKnownUserIds() {
    try {
        if (fs.existsSync(KNOWN_USERS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(KNOWN_USERS_FILE, 'utf8'));
            knownUserIds = new Set(Array.isArray(raw) ? raw : []);
        }
    } catch (e) {
        console.error('❌ [UserFilterSync] Erro ao carregar known_jellyfin_users.json:', e.message);
        knownUserIds = new Set();
    }
}

function saveKnownUserIds() {
    try {
        fs.writeFileSync(KNOWN_USERS_FILE, JSON.stringify([...knownUserIds], null, 2));
    } catch (e) {
        console.error('❌ [UserFilterSync] Erro ao salvar known_jellyfin_users.json:', e.message);
    }
}

async function syncNewUsersToWebhookFilter() {
    if (!JELLYFIN_API_KEY) return;

    const usersResp = await fetchWithRetry(`${JELLYFIN_URL}/Users`, {
        headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
    });
    if (!usersResp.ok) {
        console.log(`⚠️ [UserFilterSync] Falha ao listar usuários: HTTP ${usersResp.status}`);
        return;
    }
    const users = await usersResp.json();

    // 1ª execução: não sabemos ainda quem já existia antes do recurso ser ligado.
    // Grava o estado atual como "conhecido" e não altera o filtro (evita mexer em contas antigas sem pedir).
    if (knownUserIds.size === 0 && !fs.existsSync(KNOWN_USERS_FILE)) {
        knownUserIds = new Set(users.map(u => u.Id));
        saveKnownUserIds();
        console.log(`👥 [UserFilterSync] Estado inicial gravado: ${knownUserIds.size} usuário(s) existente(s) marcados como já conhecidos.`);
        return;
    }

    const newUsers = users.filter(u => !knownUserIds.has(u.Id));
    if (newUsers.length === 0) return;

    console.log(`🆕 [UserFilterSync] Usuário(s) novo(s) detectado(s): ${newUsers.map(u => u.Name).join(', ')}`);

    const configResp = await fetchWithRetry(`${JELLYFIN_URL}/Plugins/${WEBHOOK_PLUGIN_ID}/Configuration`, {
        headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
    });
    if (!configResp.ok) {
        console.log(`⚠️ [UserFilterSync] Falha ao ler config do plugin Webhook: HTTP ${configResp.status}`);
        return;
    }
    const config = await configResp.json();

    let alterado = false;
    for (const option of config.GenericOptions || []) {
        option.UserFilter = option.UserFilter || [];
        for (const u of newUsers) {
            if (!option.UserFilter.includes(u.Id)) {
                option.UserFilter.push(u.Id);
                alterado = true;
            }
        }
    }

    if (alterado) {
        const saveResp = await fetchWithRetry(`${JELLYFIN_URL}/Plugins/${WEBHOOK_PLUGIN_ID}/Configuration`, {
            method: 'POST',
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (!saveResp.ok) {
            console.log(`⚠️ [UserFilterSync] Falha ao salvar config do plugin Webhook: HTTP ${saveResp.status} (tenta de novo no próximo ciclo)`);
            return; // não marca como conhecido: tenta de novo no próximo ciclo
        }
        console.log(`✅ [UserFilterSync] Webhook de reprodução habilitado para: ${newUsers.map(u => u.Name).join(', ')}`);
    }

    for (const u of newUsers) knownUserIds.add(u.Id);
    saveKnownUserIds();
}

function startUserFilterSyncScheduler() {
    if (!JELLYFIN_API_KEY) {
        console.log('⚠️ Sincronização de novos usuários com o Webhook desativada: configure JELLYFIN_API_KEY.');
        return;
    }
    loadKnownUserIds();
    console.log(`👥 Sincronização automática de novos usuários → filtro do Webhook ativa (a cada ${USER_FILTER_SYNC_MINUTES} min).`);
    const tick = () => syncNewUsersToWebhookFilter().catch(e => console.error('❌ [UserFilterSync] Erro:', e.message));
    setTimeout(tick, 10000);
    setInterval(tick, USER_FILTER_SYNC_MINUTES * 60 * 1000);
}

// ---------- FETCH COM RETRY E AGENT HTTPS ----------
async function fetchWithRetry(url, options = {}, maxRetries = 3, delay = 1000) {
    if (url.startsWith('https://') && !options.agent) {
        options.agent = httpsAgent;
    }
    let lastError;
    let alvo = String(url).slice(0, 60);
    try { alvo = new URL(url).host; } catch (e) {}
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            if (response.status === 404 || response.status === 401 || response.status === 403) {
                return response;
            }
            if (i < maxRetries - 1) {
                const waitTime = delay * (i + 1);
                console.log(`⏳ ${alvo}: tentativa ${i+1}/${maxRetries} falhou (HTTP ${response.status}), aguardando ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                return response;
            }
        } catch (err) {
            lastError = err;
            if (i < maxRetries - 1) {
                const waitTime = delay * (i + 1);
                console.log(`⏳ ${alvo}: tentativa ${i+1}/${maxRetries} falhou (${err.cause && err.cause.code ? err.cause.code : err.message}), aguardando ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    throw lastError || new Error(`Falha após ${maxRetries} tentativas`);
}

// ---------- BUSCAR ITEM COMPLETO PELA API ----------
async function fetchItemFromJellyfin(itemId) {
    if (!itemId || !JELLYFIN_API_KEY) return null;

    if (itemInfoCache.has(itemId)) {
        const cached = itemInfoCache.get(itemId);
        if (Date.now() - cached.timestamp < 3600000) {
            return cached.data;
        }
        itemInfoCache.delete(itemId);
    }

    try {
        const url = `${JELLYFIN_URL}/Users/Items/${itemId}`;
        const response = await fetchWithRetry(url, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
        });

        if (response.ok) {
            const item = await response.json();
            itemInfoCache.set(itemId, { data: item, timestamp: Date.now() });
            console.log(`📦 Dados completos do item ${itemId} obtidos via API`);
            return item;
        } else {
            console.log(`⚠️ Falha ao buscar item ${itemId}: ${response.status}`);
            return null;
        }
    } catch (err) {
        console.error(`❌ Erro ao buscar item ${itemId}:`, err.message);
        return null;
    }
}

// ---------- EXTRAÇÃO ROUBUSTA DE ITEM ----------
function deepFindId(obj, depth = 0) {
    if (depth > 5) return null;
    if (!obj || typeof obj !== 'object') return null;

    if (obj.Id) return obj.Id;
    if (obj.ItemId) return obj.ItemId;

    const commonNested = ['Item', 'Data', 'ItemData', 'MediaItem'];
    for (const key of commonNested) {
        if (obj[key] && typeof obj[key] === 'object') {
            const found = deepFindId(obj[key], depth + 1);
            if (found) return found;
        }
    }

    for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === 'object') {
            const found = deepFindId(obj[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function extractItem(payload, eventType) {
    if (payload.Item && typeof payload.Item === 'object' && Object.keys(payload.Item).length > 0) {
        return payload.Item;
    }

    const foundId = deepFindId(payload);
    if (foundId) {
        const item = { Id: foundId, ItemId: foundId };
        if (payload.Name && payload.Name !== payload.NotificationType) item.Name = payload.Name;
        else if (payload.ItemName) item.Name = payload.ItemName;
        else if (payload.Title) item.Name = payload.Title;

        if (payload.Type) item.Type = payload.Type;
        else if (payload.ItemType) item.Type = payload.ItemType;
        else if (payload.MediaType) item.Type = payload.MediaType;

        if (payload.Overview) item.Overview = payload.Overview;
        if (payload.ProductionYear) item.ProductionYear = payload.ProductionYear;
        if (payload.Year) item.Year = payload.Year;
        if (payload.RunTimeTicks) item.RunTimeTicks = payload.RunTimeTicks;
        if (payload.CommunityRating) item.CommunityRating = payload.CommunityRating;
        if (payload.SeriesName) item.SeriesName = payload.SeriesName;
        if (payload.SeasonNumber) item.SeasonNumber = payload.SeasonNumber;
        if (payload.EpisodeNumber) item.EpisodeNumber = payload.EpisodeNumber;
        if (payload.SeriesId) item.SeriesId = payload.SeriesId;

        return item;
    }

    const possibleProps = ['Name', 'Id', 'ItemId', 'Type', 'Overview', 'ProductionYear', 'Year',
        'SeriesName', 'SeasonNumber', 'EpisodeNumber', 'RunTimeTicks', 'RunTime',
        'CommunityRating', 'ProviderIds', 'SeriesId'];
    const item = {};
    let hasAny = false;
    for (const prop of possibleProps) {
        if (payload[prop] !== undefined) {
            item[prop] = payload[prop];
            hasAny = true;
        }
    }
    if (item.ProductionYear && !item.Year) item.Year = item.ProductionYear;
    return hasAny ? item : null;
}

// ---------- ENRIQUECIMENTO COM FALLBACK DE BUSCA POR NOME ----------
async function enrichItemWithApi(item, eventType) {
    if (!item) return null;
    const itemId = item.Id || item.ItemId;
    if (!itemId) return item;

    if (item.Name && item.Type && (item.Overview || item.RunTimeTicks) && (item.Type !== 'Episode' || item.SeriesId)) {
        return item;
    }

    let fullItem = await fetchItemFromJellyfin(itemId);

    if (!fullItem && item?.Name && JELLYFIN_API_KEY) {
        console.log(`🔍 Buscando item por nome: "${item.Name}" (fallback de ID)`);
        try {
            const searchUrl = `${JELLYFIN_URL}/Items?searchTerm=${encodeURIComponent(item.Name)}&limit=1&IncludeItemTypes=${item.Type || ''}`;
            const resp = await fetchWithRetry(searchUrl, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.Items && data.Items.length > 0) {
                    fullItem = data.Items[0];
                    console.log(`✅ Item encontrado por busca textual: ${fullItem.Id}`);
                }
            }
        } catch (e) {
            console.log(`⚠️ Busca por nome falhou: ${e.message}`);
        }
    }

    if (fullItem) {
        return { ...fullItem, ...item };
    }
    return item;
}

// ---------- NOTAS DO IMDB (só no aviso de conteúdo novo) ----------
// Arquivo público oficial do IMDb, atualizado diariamente, sem chave de API. É lido em streaming
// a cada consulta (ItemAdded é raro) para não manter ~1,5 milhão de títulos na memória.
const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const IMDB_RATINGS_FILE = path.join(__dirname, 'imdb-title-ratings.tsv.gz');
const IMDB_RATINGS_MAX_IDADE_MS = 24 * 60 * 60 * 1000;
let imdbDownloadEmAndamento = null;

async function garantirArquivoNotasImdb() {
    try {
        const st = fs.statSync(IMDB_RATINGS_FILE);
        if (Date.now() - st.mtimeMs < IMDB_RATINGS_MAX_IDADE_MS) return true;
    } catch (_) { /* ainda não baixado */ }

    if (!imdbDownloadEmAndamento) {
        imdbDownloadEmAndamento = (async () => {
            try {
                const resp = await fetchWithRetry(IMDB_RATINGS_URL, {}, 2, 2000);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const tmp = `${IMDB_RATINGS_FILE}.tmp`;
                fs.writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
                fs.renameSync(tmp, IMDB_RATINGS_FILE);
                console.log('⭐ Arquivo de notas do IMDb atualizado.');
            } catch (err) {
                console.error('❌ Falha ao baixar notas do IMDb:', err.message);
            } finally {
                imdbDownloadEmAndamento = null;
            }
        })();
    }
    await imdbDownloadEmAndamento;
    return fs.existsSync(IMDB_RATINGS_FILE); // arquivo antigo ainda serve se o download falhar
}

// Retorna Map imdbId → { nota, votos } só com os IDs pedidos.
async function lerNotasImdb(ids) {
    const faltando = new Set(ids.filter(Boolean));
    const notas = new Map();
    if (faltando.size === 0 || !(await garantirArquivoNotasImdb())) return notas;

    const stream = fs.createReadStream(IMDB_RATINGS_FILE).pipe(require('zlib').createGunzip());
    const linhas = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const linha of linhas) {
        const tab = linha.indexOf('\t');
        const id = linha.slice(0, tab);
        if (!faltando.has(id)) continue;
        const [, nota, votos] = linha.split('\t');
        notas.set(id, { nota, votos: Number(votos).toLocaleString('pt-BR') });
        faltando.delete(id);
        if (faltando.size === 0) break;
    }
    linhas.close();
    stream.destroy();
    return notas;
}

// Busca o ID do IMDb no Jellyfin (o payload do webhook não traz ProviderIds) e a nota do próprio item
// — num episódio, a nota do episódio, nunca a da série.
async function buscarNotasImdb(item, itemId) {
    try {
        if (!JELLYFIN_API_KEY || !itemId) return null;
        const resp = await fetchWithRetry(`${JELLYFIN_URL}/Items?Ids=${itemId}&Recursive=true&Fields=ProviderIds`, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
        });
        if (!resp.ok) return null;
        const imdbId = (await resp.json()).Items?.[0]?.ProviderIds?.Imdb;
        const nota = (await lerNotasImdb([imdbId])).get(imdbId);
        console.log(`⭐ IMDb "${item.Name}": ${nota?.nota || '—'}`);
        return { imdbId, item: nota };
    } catch (err) {
        console.error('❌ Erro ao buscar notas do IMDb:', err.message);
        return null;
    }
}

// ---------- ÁUDIO/LEGENDA: DETECTA SE O CONTEÚDO É DUBLADO OU LEGENDADO ----------
function classificarAudioLegenda(streams) {
    const idiomaPt = (lang) => /^(por|pt|Portuguese|ptb)$/i.test(String(lang || '').split('-')[0]);
    const tituloPt = (title) => /portugu[eê]s|brazil|brasil|pt[\s-]?br|dublad/i.test(String(title || ''));
    const audios = streams.filter(s => s.Type === 'Audio');
    const legendas = streams.filter(s => s.Type === 'Subtitle');
    const dublado = audios.some(s => idiomaPt(s.Language) || tituloPt(s.Title) || tituloPt(s.DisplayTitle));
    const legendado = legendas.some(s => idiomaPt(s.Language) || tituloPt(s.Title) || tituloPt(s.DisplayTitle));
    return { dublado, legendado };
}

async function buscarInfoAudioLegenda(item, itemId) {
    if (!JELLYFIN_API_KEY || !itemId) return null;
    try {
        if (['Series', 'Season'].includes(item.Type)) {
            const url = `${JELLYFIN_URL}/Items?ParentId=${itemId}&Recursive=true&IncludeItemTypes=Episode&Fields=MediaSources&Limit=1&SortBy=SortName`;
            const resp = await fetchWithRetry(url, { headers: { 'X-Emby-Token': JELLYFIN_API_KEY } });
            if (!resp.ok) return null;
            const ep = (await resp.json()).Items?.[0];
            if (!ep) return null;
            return classificarAudioLegenda(ep.MediaSources?.[0]?.MediaStreams || []);
        }
        const url = `${JELLYFIN_URL}/Items?Ids=${itemId}&Recursive=true&Fields=MediaSources`;
        const resp = await fetchWithRetry(url, { headers: { 'X-Emby-Token': JELLYFIN_API_KEY } });
        if (!resp.ok) return null;
        const dados = (await resp.json()).Items?.[0];
        if (!dados) return null;
        return classificarAudioLegenda(dados.MediaSources?.[0]?.MediaStreams || []);
    } catch (err) {
        console.error(`❌ Erro ao buscar áudio/legenda de ${itemId}:`, err.message);
        return null;
    }
}

// ---------- ITEMADDED: SÓ AVISA QUANDO O JELLYFIN CONSEGUE ABRIR O ARQUIVO ----------
// O Jellyfin dispara ItemAdded assim que vê o arquivo, mesmo no meio de uma cópia ou quando não
// consegue lê-lo (permissão) — aí o item fica com duração 0 e sem faixas, e o link não reproduz.
const ITEM_ADDED_DELAY_MINUTES = parsePositiveInt(process.env.ITEM_ADDED_DELAY_MINUTES, 5);
const ITEM_ADDED_MAX_TENTATIVAS = parsePositiveInt(process.env.ITEM_ADDED_MAX_TENTATIVAS, 3);
const TIPOS_REPRODUZIVEIS = ['Movie', 'Episode', 'Video', 'MusicVideo'];

// Retorna { status: 'ok' | 'sem_midia' | 'removido' | 'erro', item }. Não usa o cache: precisa do estado atual.
async function consultarMidiaDoItem(itemId) {
    try {
        const url = `${JELLYFIN_URL}/Items?Ids=${itemId}&Recursive=true&Fields=MediaSources`;
        const response = await fetchWithRetry(url, { headers: { 'X-Emby-Token': JELLYFIN_API_KEY } });
        if (!response.ok) return { status: 'erro' };
        const data = await response.json();
        const fresh = data.Items && data.Items[0];
        if (!fresh) return { status: 'removido' };
        const streams = fresh.MediaSources?.[0]?.MediaStreams || [];
        const temFaixa = streams.some(s => s.Type === 'Video' || s.Type === 'Audio');
        return { status: fresh.RunTimeTicks > 0 && temFaixa ? 'ok' : 'sem_midia', item: fresh };
    } catch (err) {
        console.error(`❌ Erro ao consultar mídia do item ${itemId}:`, err.message);
        return { status: 'erro' };
    }
}

// Série/temporada sem nenhum episódio com vídeo: gravação da TV ao vivo que falhou (a ponte sem sinal) deixa só
// o .nfo em Gravacoes/<série>/Season N, o Jellyfin cria a temporada vazia e o link do aviso dá erro (12/10).
// Retorna 'ok' | 'vazio' | 'erro'.
async function consultarEpisodiosReproduziveis(itemId) {
    try {
        const url = `${JELLYFIN_URL}/Items?ParentId=${itemId}&Recursive=true&IncludeItemTypes=Episode&Fields=MediaSources&Limit=50`;
        const response = await fetchWithRetry(url, { headers: { 'X-Emby-Token': JELLYFIN_API_KEY } });
        if (!response.ok) return 'erro';
        const data = await response.json();
        const algum = (data.Items || []).some(ep => ep.RunTimeTicks > 0 && ep.LocationType !== 'Virtual');
        return algum ? 'ok' : 'vazio';
    } catch (err) {
        console.error(`❌ Erro ao consultar episódios do item ${itemId}:`, err.message);
        return 'erro';
    }
}

// Espera o arquivo ficar reproduzível. Retorna o item atualizado, ou null se não deve avisar.
async function aguardarItemReproduzivel(item, itemId) {
    if (itemId && JELLYFIN_API_KEY && ['Season', 'Series'].includes(item.Type)) {
        for (let tentativa = 1; tentativa <= ITEM_ADDED_MAX_TENTATIVAS; tentativa++) {
            console.log(`⏳ ItemAdded "${item.Name}" (${item.Type}): aguardando ${ITEM_ADDED_DELAY_MINUTES} min antes de conferir os episódios (tentativa ${tentativa}/${ITEM_ADDED_MAX_TENTATIVAS})`);
            await new Promise(resolve => setTimeout(resolve, ITEM_ADDED_DELAY_MINUTES * 60000));
            const status = await consultarEpisodiosReproduziveis(itemId);
            if (status === 'ok') return item;
            if (status === 'erro') {
                console.log(`⚠️ Não foi possível conferir os episódios de "${item.Name}" — enviando assim mesmo.`);
                return item;
            }
            console.log(`⚠️ "${item.Name}" (${itemId}) ainda sem nenhum episódio com vídeo.`);
        }
        console.log(`⏩ ItemAdded "${item.Name}" (${item.Type}) sem episódio reproduzível (gravação que falhou?) — aviso NÃO enviado.`);
        return null;
    }
    if (!itemId || !JELLYFIN_API_KEY || !TIPOS_REPRODUZIVEIS.includes(item.Type)) return item;

    for (let tentativa = 1; tentativa <= ITEM_ADDED_MAX_TENTATIVAS; tentativa++) {
        console.log(`⏳ ItemAdded "${item.Name}": aguardando ${ITEM_ADDED_DELAY_MINUTES} min antes de conferir o arquivo (tentativa ${tentativa}/${ITEM_ADDED_MAX_TENTATIVAS})`);
        await new Promise(resolve => setTimeout(resolve, ITEM_ADDED_DELAY_MINUTES * 60000));

        const { status, item: fresh } = await consultarMidiaDoItem(itemId);
        if (status === 'ok') {
            return { ...item, RunTimeTicks: fresh.RunTimeTicks };
        }
        if (status === 'removido') {
            console.log(`⏩ ItemAdded "${item.Name}" (${itemId}) não existe mais no Jellyfin — aviso cancelado.`);
            return null;
        }
        if (status === 'erro') {
            // Jellyfin fora do ar não deve engolir o aviso.
            console.log(`⚠️ Não foi possível conferir "${item.Name}" no Jellyfin — enviando assim mesmo.`);
            return item;
        }
        console.log(`⚠️ "${item.Name}" (${itemId}) ainda sem duração/faixas no Jellyfin (arquivo copiando ou sem permissão de leitura).`);
    }

    console.log(`⏩ ItemAdded "${item.Name}" (${itemId}) não ficou reproduzível após ${ITEM_ADDED_MAX_TENTATIVAS} tentativas — aviso NÃO enviado.`);
    return null;
}

// ---------- ITEMADDED: SÉRIE NOVA COM TEMPORADAS "ÓRFÃS" ----------
// Com o agrupamento automático de séries, a série ganha a chave do TVDB depois de identificada, mas as
// temporadas/episódios gravados antes ficam com a chave antiga: /Shows/{id}/Episodes volta vazio e o
// "reproduzir" do link não acha nada (Shameless T11, 02/10/2026). Um refresh recursivo da série corrige.
const TIPOS_DE_SERIE = ['Series', 'Season', 'Episode'];
const serieConferindo = new Map(); // seriesId -> Promise, evita um refresh por episódio da mesma série

async function contarEpisodios(url) {
    const response = await fetchWithRetry(url, { headers: { 'X-Emby-Token': JELLYFIN_API_KEY } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).TotalRecordCount || 0;
}

// Retorna { naPasta, naSerie } — episódios dentro da pasta da série e episódios que a série enxerga.
async function contarEpisodiosDaSerie(seriesId) {
    const naPasta = await contarEpisodios(`${JELLYFIN_URL}/Items?ParentId=${seriesId}&Recursive=true&IncludeItemTypes=Episode&Limit=0`);
    const naSerie = await contarEpisodios(`${JELLYFIN_URL}/Shows/${seriesId}/Episodes?Limit=0`);
    return { naPasta, naSerie };
}

async function corrigirSerieSemEpisodios(seriesId, nome) {
    try {
        const { naPasta, naSerie } = await contarEpisodiosDaSerie(seriesId);
        // Com agrupamento entre discos a série pode enxergar MAIS episódios que a própria pasta; menos é o defeito.
        if (naSerie >= naPasta) return;

        console.log(`🛠️ Série "${nome}" (${seriesId}): ${naPasta} episódio(s) na pasta, mas só ${naSerie} visíveis — pedindo refresh recursivo ao Jellyfin.`);
        const resp = await fetchWithRetry(`${JELLYFIN_URL}/Items/${seriesId}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default`, {
            method: 'POST',
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
        });
        if (!resp.ok) {
            console.log(`⚠️ Refresh da série "${nome}" falhou: HTTP ${resp.status}`);
            return;
        }

        for (let i = 0; i < 12; i++) {
            await new Promise(resolve => setTimeout(resolve, 20000));
            const agora = await contarEpisodiosDaSerie(seriesId);
            if (agora.naSerie >= agora.naPasta) {
                console.log(`✅ Série "${nome}" corrigida: ${agora.naSerie} episódio(s) visíveis.`);
                return;
            }
        }
        console.log(`⚠️ Série "${nome}" ainda com episódios invisíveis após o refresh — avisando assim mesmo.`);
    } catch (err) {
        console.error(`❌ Erro ao conferir episódios da série ${seriesId}:`, err.message);
    }
}

// Série/temporada não passam por aguardarItemReproduzivel: esperam o mesmo intervalo antes de conferir,
// para o Jellyfin terminar de identificar a série (é quando a chave muda).
async function garantirSerieComEpisodios(item, itemId) {
    if (!JELLYFIN_API_KEY || !TIPOS_DE_SERIE.includes(item.Type)) return;
    const seriesId = item.Type === 'Series' ? itemId : item.SeriesId;
    if (!seriesId) return;

    if (!serieConferindo.has(seriesId)) {
        const espera = TIPOS_REPRODUZIVEIS.includes(item.Type) ? 0 : ITEM_ADDED_DELAY_MINUTES * 60000;
        const tarefa = new Promise(resolve => setTimeout(resolve, espera))
            .then(() => corrigirSerieSemEpisodios(seriesId, item.SeriesName || item.Name))
            .finally(() => setTimeout(() => serieConferindo.delete(seriesId), 10 * 60000));
        serieConferindo.set(seriesId, tarefa);
    }
    await serieConferindo.get(seriesId);
}

// ---------- ITEMADDED: METADADOS COMPLETOS EM PT-BR ANTES DO AVISO ----------
// Vários filmes chegam ao Jellyfin sem identificação (nome = pasta, sem sinopse/capa) ou identificados
// errado. Antes do WhatsApp o item é identificado e completado em PT-BR (lógica em metadados-ptbr.js, a
// mesma de uma varredura completa). Falha aqui só gera log: o aviso sai mesmo assim.
const metadadosPtBr = require('./metadados-ptbr');

// Só anuncia (WhatsApp e Echo) o que é do ano corrente (22/10/2026): filme pelo ano de lançamento,
// episódio/temporada pela exibição. Sem ano conhecido, anuncia assim mesmo para não engolir o aviso.
function anoDoItem(item) {
    const ano = Number(item?.ProductionYear || item?.Year);
    if (ano) return ano;
    const data = item?.PremiereDate ? new Date(item.PremiereDate) : null;
    return data && !isNaN(data) ? data.getUTCFullYear() : null;
}

async function ehConteudoDoAnoAtual(item, itemId) {
    let ano = anoDoItem(item);
    if (!ano && itemId) ano = anoDoItem(await fetchItemFromJellyfin(itemId));
    const anoAtual = Number(new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ || 'America/Sao_Paulo', year: 'numeric' }).format(new Date()));
    if (!ano) {
        console.log(`⚠️ ItemAdded "${item.Name}" sem ano conhecido — anunciando assim mesmo.`);
        return true;
    }
    if (ano !== anoAtual) {
        console.log(`⏩ ItemAdded "${item.Name}" (${item.Type}) é de ${ano}, não de ${anoAtual} — aviso NÃO enviado.`);
        return false;
    }
    return true;
}

async function completarMetadadosPtBr(item, itemId) {
    const atualizado = await metadadosPtBr.completarMetadadosPtBr(item, itemId);
    itemInfoCache.delete(itemId);
    return atualizado;
}

function extractUser(payload) {
    if (payload.User) return payload.User;
    if (payload.UserId) {
        return { Id: payload.UserId, Name: payload.UserName || `User ID: ${payload.UserId}` };
    }
    return null;
}

async function extractUserNameAsync(payload) {
    if (payload.User?.Name) return payload.User.Name;
    if (payload.UserName) return payload.UserName;
    if (payload.Username) return payload.Username;
    if (payload.NotificationUsername) return payload.NotificationUsername;
    if (payload.Name && payload.Name !== payload.Item?.Name && payload.Name !== payload.NotificationType) return payload.Name;

    const userId = payload.UserId || payload.User?.Id || payload.Id;
    if (userId && JELLYFIN_API_KEY) {
        const nome = await getUserNameFromId(userId);
        if (nome) return nome;
        return `User ID: ${userId}`;
    }
    if (userId) return `User ID: ${userId}`;
    return null;
}

async function getUserNameFromId(userId) {
    if (!userId || !JELLYFIN_API_KEY) return null;
    if (userCache.has(userId)) return userCache.get(userId);

    try {
        const url = `${JELLYFIN_URL}/Users/${userId}`;
        const response = await fetchWithRetry(url, { headers: { 'X-Emby-Token': JELLYFIN_API_KEY } });
        if (response.ok) {
            const user = await response.json();
            const name = user.Name;
            if (name) {
                userCache.set(userId, name);
                setTimeout(() => userCache.delete(userId), 3600000);
                return name;
            }
        }
    } catch (err) {
        console.error(`❌ Erro ao buscar usuário ${userId}:`, err.message);
    }
    return null;
}

// ---------- ENVIO DE TEXTO FALLBACK ----------
async function enviarTextoSimples(numero, mensagem) {
    const url = `${ATSAPP_API_URL}/send`;
    const payload = { number: numero, message: mensagem };

    try {
        const response = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, 2, 2000);
        if (response.ok) {
            console.log(`✅ Texto enviado para ${numero}`);
            return true;
        } else {
            const texto = await response.text();
            throttled(`falha-texto:${numero}:${response.status}`, 60000, (n) =>
                console.error(`❌ Falha ao enviar texto para ${numero}: ${response.status} - ${texto}${n ? ` (+${n} igual(is) nos últimos 60s, omitida(s))` : ''}`));
            return false;
        }
    } catch (err) {
        console.error(`❌ Erro de rede ao enviar texto para ${numero}:`, err.message);
        return false;
    }
}

async function enviarInicioJellyfinParaSistema(mensagem, payload = {}) {
    try {
        const response = await fetchWithRetry(`${SISTEMA_MOBILE_URL}/api/jellyfin/server-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: mensagem,
                serverName: payload.ServerName || 'Jellyfin',
                version: payload.Version || 'desconhecida'
            })
        }, 2, 1500);

        if (response.ok) {
            console.log('✅ Notificação de início do Jellyfin enviada ao sistema principal');
            return true;
        }

        const texto = await response.text().catch(() => '');
        console.error(`❌ Falha ao encaminhar início do Jellyfin: ${response.status}${texto ? ` - ${texto}` : ''}`);
        return false;
    } catch (err) {
        console.error('❌ Erro ao encaminhar início do Jellyfin ao sistema principal:', err.message);
        return false;
    }
}

// ---------- BAIXAR IMAGEM COM FETCH ----------
async function fetchImageAsBuffer(url, token, maxWidth = null) {
    let finalUrl = url;
    if (maxWidth) {
        finalUrl += `?maxWidth=${maxWidth}&quality=90`;
    }
    const options = {
        headers: { 'X-Emby-Token': token },
        agent: url.startsWith('https://') ? httpsAgent : undefined
    };
    const response = await fetchWithRetry(finalUrl, options, 2, 1000);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

// ---------- FALLBACK DE IMAGEM VIA EXTERNA (OMDb + TMDB) ----------
async function fetchExternalPoster(item) {
    if (!TMDB_API_KEY) return null;
    const tmdbId = item?.ProviderIds?.Tmdb;
    const imdbId = item?.ProviderIds?.Imdb;
    const title = item?.Name;

    try {
        // 1. Tentar por TMDB usando ID
        if (tmdbId) {
            const mediaType = (item.Type === 'Movie') ? 'movie' : 'tv';
            const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/images?api_key=${TMDB_API_KEY}`;
            const resp = await fetchWithRetry(url, {}, 2, 1000);
            if (resp.ok) {
                const data = await resp.json();
                if (data.posters && data.posters.length > 0) {
                    const posterPath = data.posters[0].file_path;
                    return `https://image.tmdb.org/t/p/w500${posterPath}`;
                }
            }
        }

        // 2. Tentar OMDb por IMDb ID
        if (imdbId) {
            const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`;
            const resp = await fetchWithRetry(url, {}, 2, 1000);
            if (resp.ok) {
                const data = await resp.json();
                if (data.Poster && data.Poster !== 'N/A') {
                    return data.Poster;
                }
            }
        }

        // 3. Fallback: buscar por título na TMDB
        if (title) {
            console.log(`🔍 Buscando TMDB por título: "${title}"`);
            const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=pt-BR`;
            const searchResp = await fetchWithRetry(searchUrl, {}, 2, 1000);
            if (searchResp.ok) {
                const searchData = await searchResp.json();
                if (searchData.results && searchData.results.length > 0) {
                    const firstResult = searchData.results[0];
                    const posterPath = firstResult.poster_path;
                    if (posterPath) {
                        return `https://image.tmdb.org/t/p/w500${posterPath}`;
                    }
                }
            }
        }
    } catch (err) {
        console.log(`⚠️ Erro ao buscar pôster externo: ${err.message}`);
    }
    return null;
}

// ---------- ENVIO DE IMAGEM COM MÚLTIPLOS FALLBACKS ----------
async function sendMediaToNumber(numero, captionText, itemId, serverUrl, item = null) {
    if (!itemId || !serverUrl) {
        return enviarTextoSimples(numero, captionText);
    }

    const imageTypes = ['Primary', 'Thumb', 'Backdrop', 'Logo', 'Art', 'Banner'];
    let imageBuffer = null;
    let usedId = itemId;

    // 1. Tentar com o ID original (episódio ou filme)
    for (const type of imageTypes) {
        const url = `${serverUrl}/Items/${itemId}/Images/${type}`;
        try {
            imageBuffer = await fetchImageAsBuffer(url, JELLYFIN_API_KEY, 500);
            console.log(`🖼️ Imagem encontrada (${type}) para ${numero} (ID: ${itemId})`);
            break;
        } catch (err) {
            // continua
        }
    }

    // 2. Se falhou e é episódio com SeriesId, tenta imagem da série
    if (!imageBuffer && item && item.Type === 'Episode' && item.SeriesId) {
        console.log(`🖼️ Tentando imagem da série (SeriesId: ${item.SeriesId})`);
        for (const type of imageTypes) {
            const url = `${serverUrl}/Items/${item.SeriesId}/Images/${type}`;
            try {
                imageBuffer = await fetchImageAsBuffer(url, JELLYFIN_API_KEY, 500);
                usedId = item.SeriesId;
                console.log(`🖼️ Imagem da série encontrada (${type}) para ${numero}`);
                break;
            } catch (err) {}
        }
    }

    // 3. Se ainda falhou e temos SeriesName, busca SeriesId via API de pesquisa
    if (!imageBuffer && item && item.Type === 'Episode' && item.SeriesName && !item.SeriesId) {
        console.log(`🔍 Buscando SeriesId para "${item.SeriesName}" via API...`);
        try {
            const searchUrl = `${serverUrl}/Search/Hints?searchTerm=${encodeURIComponent(item.SeriesName)}&IncludePeople=false&IncludeMedia=true&IncludeGenres=false&limit=1`;
            const response = await fetchWithRetry(searchUrl, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
            });
            if (response.ok) {
                const data = await response.json();
                if (data.SearchHints && data.SearchHints.length > 0) {
                    const seriesId = data.SearchHints[0].Id;
                    console.log(`✅ SeriesId encontrado: ${seriesId}`);
                    for (const type of imageTypes) {
                        const url = `${serverUrl}/Items/${seriesId}/Images/${type}`;
                        try {
                            imageBuffer = await fetchImageAsBuffer(url, JELLYFIN_API_KEY, 500);
                            usedId = seriesId;
                            console.log(`🖼️ Imagem da série (busca) encontrada (${type})`);
                            break;
                        } catch (err) {}
                    }
                }
            }
        } catch (err) {
            console.log(`⚠️ Erro na busca por série: ${err.message}`);
        }
    }

    // 4. Fallback para API externa (OMDb + TMDB)
    if (!imageBuffer && item) {
        console.log(`🖼️ Tentando pôster externo (OMDb/TMDB)...`);
        const externalUrl = await fetchExternalPoster(item);
        if (externalUrl) {
            try {
                const resp = await fetchWithRetry(externalUrl, {}, 2, 1000);
                if (resp.ok) {
                    imageBuffer = Buffer.from(await resp.arrayBuffer());
                    console.log(`🖼️ Pôster externo baixado com sucesso`);
                }
            } catch (err) {
                console.log(`⚠️ Falha ao baixar pôster externo: ${err.message}`);
            }
        }
    }

    // 5. Fallback para imagem padrão (URL configurável via .env)
    if (!imageBuffer) {
        const defaultImageUrl = process.env.DEFAULT_POSTER_URL || '';
        if (defaultImageUrl) {
            console.log(`🖼️ Tentando imagem padrão: ${defaultImageUrl}`);
            try {
                const response = await fetchWithRetry(defaultImageUrl, {}, 2, 1000);
                if (response.ok) {
                    imageBuffer = Buffer.from(await response.arrayBuffer());
                    console.log(`🖼️ Imagem padrão baixada com sucesso`);
                } else {
                    console.log(`⚠️ Falha ao baixar imagem padrão: HTTP ${response.status}`);
                }
            } catch (err) {
                console.log(`⚠️ Erro ao baixar imagem padrão: ${err.message}`);
            }
        }
    }

    // 6. Fallback para placeholder PNG via sharp
    if (!imageBuffer) {
        const title = item?.Name || 'Mídia';
        const escapedTitle = title.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c] || c));
        try {
            const width = 500, height = 750;
            const svgBuffer = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
                <rect width="100%" height="100%" fill="#2c3e50"/>
                <text x="50%" y="45%" font-family="Arial" font-size="36" fill="white" text-anchor="middle" dominant-baseline="central" font-weight="bold">${escapedTitle}</text>
                <text x="50%" y="55%" font-family="Arial" font-size="20" fill="#bdc3c7" text-anchor="middle">Jellyfin</text>
            </svg>`);
            imageBuffer = await sharp(svgBuffer).png().toBuffer();
            console.log(`🖼️ Placeholder PNG gerado para "${title}"`);
        } catch (err) {
            console.log(`⚠️ Erro ao gerar placeholder com sharp, usando SVG bruto: ${err.message}`);
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
                <rect width="500" height="750" fill="#2c3e50"/>
                <text x="250" y="375" font-family="Arial" font-size="40" fill="white" text-anchor="middle" font-weight="bold">${escapedTitle}</text>
                <text x="250" y="425" font-family="Arial" font-size="20" fill="#bdc3c7" text-anchor="middle">Jellyfin</text>
            </svg>`;
            imageBuffer = Buffer.from(svg);
        }
    }

    // Salvar e enviar como PNG
    const tempFilePath = path.join('/tmp', `poster_${Date.now()}_${numero}.png`);
    fs.writeFileSync(tempFilePath, imageBuffer);

    const payload = {
        number: numero,
        filePath: tempFilePath,
        fileName: 'poster.png',
        caption: captionText,
        mimetype: 'image/png'
    };

    try {
        const response = await fetchWithRetry(`${ATSAPP_API_URL}/send-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, 2, 2000);
        fs.unlink(tempFilePath, () => {});
        if (response.ok) {
            console.log(`✅ Imagem + legenda enviado para ${numero}`);
            return true;
        } else {
            const errorText = await response.text();
            throttled(`falha-imagem:${numero}:${response.status}`, 60000, (n) =>
                console.error(`❌ Falha ao enviar imagem para ${numero}: ${response.status} - ${errorText}${n ? ` (+${n} igual(is) nos últimos 60s, omitida(s))` : ''}`));
            return enviarTextoSimples(numero, captionText);
        }
    } catch (err) {
        console.error(`❌ Erro ao enviar imagem para ${numero}:`, err.message);
        fs.unlink(tempFilePath, () => {});
        return false;
    }
}

async function enviarParaNumero(numero, mensagem, itemId = null, serverUrl = null, item = null, enfileirarSeFalhar = true) {
    let success = false;
    if (itemId && serverUrl) {
        success = await sendMediaToNumber(numero, mensagem, itemId, serverUrl, item);
    } else {
        success = await enviarTextoSimples(numero, mensagem);
    }

    // No reenvio (enfileirarSeFalhar=false) quem reagenda é processRetryQueue; enfileirar aqui também duplicava a mensagem a cada falha.
    if (!success && enfileirarSeFalhar) {
        console.log(`⏳ Adicionando mensagem à fila de retry para ${numero}`);
        retryQueue.push({ numero, mensagem, itemId, serverUrl, item, tentativas: 1 });
        setTimeout(processRetryQueue, 60000);
    }
    return success;
}

// ---------- DEBOUNCE ----------
function shouldSendMessage(messageKey, cooldownSeconds = 30) {
    if (!messageKey) return true;
    const now = Date.now();
    if (sentMessagesCache.has(messageKey)) {
        const lastSent = sentMessagesCache.get(messageKey);
        if (now - lastSent < cooldownSeconds * 1000) return false;
    }
    sentMessagesCache.set(messageKey, now);
    setTimeout(() => sentMessagesCache.delete(messageKey), cooldownSeconds * 1000);
    return true;
}

// ---------- MENSAGEM SIMPLES ----------
function buildSimpleMessage(eventType, fullData, item, userName) {
    switch (eventType) {
        case 'ServerStarted':
            return `🚀 *JELLYFIN INICIADO*\n\n📡 Servidor: ${fullData.ServerName || 'Jellyfin'}\n🆙 Versão: ${fullData.Version || 'desconhecida'}\n⏰ ${new Date().toLocaleString('pt-BR')}`;
        case 'ServerRestarting':
            return `🔄 *JELLYFIN REINICIANDO*\n\n📡 Servidor: ${fullData.ServerName || 'Jellyfin'}\n🆙 Versão: ${fullData.Version || 'desconhecida'}\n⏰ ${new Date().toLocaleString('pt-BR')}`;
        case 'SessionStart':
            const sessionUser = userName || 'desconhecido';
            const client = fullData.Client || fullData._client || 'desconhecido';
            return `🟢 *Sessão iniciada*\n👤 Usuário: ${sessionUser}\n📱 Cliente: ${client}`;
        case 'SessionEnd':
            const endUser = userName || 'desconhecido';
            return `🔴 *Sessão encerrada*\n👤 Usuário: ${endUser}`;
        case 'UserAuthenticated':
        case 'AuthenticationSuccess':
            const authUser = userName || 'desconhecido';
            return `✅ *Usuário autenticado*: ${authUser}`;
        case 'UserLockedOut':
            const lockedUser = userName || 'desconhecido';
            return `🔒 *Usuário bloqueado*: ${lockedUser}`;
        case 'TaskCompleted':
            const taskName = fullData.Name || 'desconhecida';
            return `✔️ *Tarefa concluída*: ${taskName}`;
        case 'ItemDeleted':
            const deletedItemName = item?.Name || fullData.Name || 'item desconhecido';
            let itemType = 'Conteúdo';
            if (item?.Type === 'Movie' || fullData.Type === 'Movie') itemType = 'Filme';
            else if (item?.Type === 'Episode' || fullData.Type === 'Episode') itemType = 'Episódio';
            else if (item?.Type === 'Series' || fullData.Type === 'Series') itemType = 'Série';
            return `🗑️ *Item removido*\n📀 Tipo: ${itemType}\n🎬 Nome: ${deletedItemName}`;
        default:
            let summary = `🔔 *Evento Jellyfin*\n📌 Tipo: ${eventType}`;
            if (userName) summary += `\n👤 Usuário: ${userName}`;
            if (item?.Name || fullData.Item?.Name || fullData.Name)
                summary += `\n🎬 Item: ${item?.Name || fullData.Item?.Name || fullData.Name}`;
            if (fullData.Message) summary += `\n💬 Mensagem: ${fullData.Message}`;
            return summary;
    }
}

// ---------- MENSAGEM RICA (com link corrigido) ----------
function buildRichMessage(eventType, item, userName, serverUrl, serverId, itemIdOverride) {
    const name = item.Name || 'Título não informado';
    const year = item.Year || item.ProductionYear || '';
    const type = item.Type || (eventType === 'ItemAdded' ? 'Conteúdo' : '');
    const seriesName = item.SeriesName || '';
    // Payload do webhook traz SeasonNumber/EpisodeNumber; a API do Jellyfin, ParentIndexNumber/IndexNumber
    const seasonNum = item.SeasonNumber ?? (item.Type === 'Episode' ? item.ParentIndexNumber : null);
    const episodeNum = item.EpisodeNumber ?? (item.Type === 'Episode' ? item.IndexNumber : null);
    const season = seasonNum != null && seasonNum !== '' ? `T${seasonNum.toString().padStart(2, '0')}` : '';
    const episode = episodeNum ? `E${episodeNum.toString().padStart(2, '0')}` : '';
    const episodeName = item.Name && seriesName ? item.Name : '';
    const overview = item.Overview || '';
    let runtime = formatRuntime(item.RunTimeTicks || item.RunTime);
    const communityRating = item.CommunityRating ? parseFloat(item.CommunityRating).toFixed(1) : null;
    const providerIds = item.ProviderIds || {};
    const imdbId = providerIds.Imdb;
    const tmdbId = providerIds.Tmdb;

    let msg = '';
    if (eventType === 'ItemAdded') msg = '🎬 *NOVO CONTEÚDO ADICIONADO*\n\n';
    else if (eventType === 'PlaybackStart') msg = '▶️ *REPRODUÇÃO INICIADA*\n\n';
    else if (eventType === 'PlaybackStop') msg = '⏹️ *REPRODUÇÃO PARADA*\n\n';
    else msg = `🔔 *${eventType}*\n\n`;

    if (seriesName) {
        msg += `📺 *${seriesName}*\n`;
        if (season && episode) msg += `📀 ${season}${episode}`;
        if (episodeName) msg += `: ${episodeName}`;
        msg += '\n';
    } else {
        msg += `🎬 *${name}*`;
        if (year) msg += ` (${year})`;
        msg += `\n📀 Tipo: ${type === 'Movie' ? 'Filme' : type === 'Episode' ? 'Episódio' : type}\n`;
    }

    if (runtime) msg += `⏱️ Duração: ${runtime}\n`;
    const notasImdb = eventType === 'ItemAdded' ? item._notasImdb : null;
    if (eventType === 'ItemAdded') {
        if (notasImdb?.item) msg += `⭐ IMDb: ${notasImdb.item.nota}\n`;
        // CommunityRating do Jellyfin vem do TMDb
        if (communityRating) msg += `🍿 TMDb: ${communityRating}/10\n`;
    } else if (communityRating) {
        msg += `⭐ Avaliação: ${communityRating}/10\n`;
    }
    if (userName && (eventType === 'PlaybackStart' || eventType === 'PlaybackStop')) {
        msg += `👤 Usuário: ${userName}\n`;
    }
    if (eventType === 'ItemAdded') {
        const original = item.OriginalTitle && item.OriginalTitle !== name && item.OriginalTitle !== seriesName ? item.OriginalTitle : '';
        if (original) msg += `🌎 Título original: ${original}\n`;
        if (item.Genres?.length) msg += `🎭 Gêneros: ${item.Genres.slice(0, 4).join(', ')}\n`;
        if (item.OfficialRating) msg += `🔞 Classificação: ${item.OfficialRating.replace(/^BR-/, '')}\n`;
        const al = item._audioLegenda;
        if (al) {
            if (al.dublado && al.legendado) msg += `🗣️ Dublado + Legendado em PT-BR\n`;
            else if (al.dublado) msg += `🗣️ Dublado em PT-BR\n`;
            else if (al.legendado) msg += `📝 Legendado em PT-BR\n`;
            else msg += `🌐 Sem áudio/legenda em PT-BR\n`;
        }
        if (item.PremiereDate && !seriesName) msg += `📅 Estreia: ${new Date(item.PremiereDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}\n`;
        const pessoas = item.People || [];
        const direcao = pessoas.filter(p => p.Type === 'Director').slice(0, 2).map(p => p.Name);
        if (direcao.length) msg += `🎬 Direção: ${direcao.join(', ')}\n`;
        const elenco = pessoas.filter(p => p.Type === 'Actor').slice(0, 5).map(p => p.Name);
        if (elenco.length) msg += `👥 Elenco: ${elenco.join(', ')}\n`;
        if (item.Taglines?.[0]) msg += `\n💬 _${item.Taglines[0]}_\n`;
    }
    if (overview) {
        const limite = eventType === 'ItemAdded' ? 700 : 300;
        const shortOverview = overview.length > limite ? overview.substring(0, limite) + '…' : overview;
        msg += `\n📝 ${shortOverview}\n`;
    }

    // Link do item — link /app/item/ID (um app/redirecionador seu pode abrir direto o item; senão use o Jellyfin web)
    const itemId = itemIdOverride || item.Id || item.ItemId;
    if (itemId) {
        const linkBase = PUBLIC_JELLYFIN_URL || serverUrl || JELLYFIN_URL;
        const deepLink = `${linkBase}/app/item/${itemId}`;
        msg += `\n📺 Abrir: ${deepLink}`;
    }
    const imdbLinkId = imdbId || notasImdb?.imdbId;
    if (imdbLinkId) {
        msg += `\n🔗 IMDb: https://www.imdb.com/title/${imdbLinkId}/`;
    }
    if (tmdbId) {
        const tmdbType = (type === 'Movie') ? 'movie' : 'tv';
        msg += `\n🔗 TMDb: https://www.themoviedb.org/${tmdbType}/${tmdbId}/`;
    }
    return msg.trim();
}

// ---------- WEBHOOK PRINCIPAL ----------
app.post('/jellyfin-webhook', async (req, res) => {
    res.status(200).send('OK');

    console.log('\n🎬 Webhook recebido!');
    let payload = req.body;

    console.log('📦 Payload completo (primeiros 500 chars):', JSON.stringify(payload, null, 2).slice(0, 500));
    if (JSON.stringify(payload).length > 500) {
        console.log('   ... (payload truncado, veja logs completos se necessário)');
    }

    let eventType = payload.EventType || payload.NotificationType || null;
    let item = null;
    let userName = null;
    let serverUrl = payload.ServerUrl || JELLYFIN_URL;
    let serverId = payload.ServerId || JELLYFIN_SERVER_ID || '';

    // Extrai ID bruto do payload ANTES de modificar o item
    let rawItemId = null;
    if (payload.Item?.Id) rawItemId = payload.Item.Id;
    else if (payload.ItemId) rawItemId = payload.ItemId;
    else if (payload.Id) rawItemId = payload.Id;

    if (!eventType) {
        console.log('⚠️ Não foi possível determinar o tipo de evento.');
        return;
    }

    item = extractItem(payload, eventType);

    // Parada de reprodução nunca avisa (pedido do usuário 27/10/2026): nem WhatsApp, nem poster, nem Echo.
    if (eventType === 'PlaybackStop') {
        console.log(`⏩ PlaybackStop ignorado: reprodução não anuncia parada.`);
        return;
    }

    const eventosComPoster = ['PlaybackStart', 'ItemAdded'];
    if (eventosComPoster.includes(eventType) && item) {
        item = await enrichItemWithApi(item, eventType);
        console.log(`📦 Item após enriquecimento: ID=${item.Id || item.ItemId}, Nome=${item.Name}, Tipo=${item.Type}, SeriesId=${item.SeriesId || 'não tem'}`);
    }

    if (['SessionStart', 'SessionEnd', 'UserAuthenticated', 'AuthenticationSuccess', 'UserLockedOut', 'PlaybackStart'].includes(eventType)) {
        userName = await extractUserNameAsync(payload);
        if (!userName && payload.UserName) userName = payload.UserName;
        if (!userName && payload.User?.Name) userName = payload.User.Name;
        if (!userName && eventType !== 'PlaybackStart' && eventType !== 'PlaybackStop') userName = 'Usuário não identificado';
    }

    // ---------- FILTRO DE REPRODUÇÃO: 1 aviso por filme/episódio iniciado (pedido do usuário 27/10/2026) ----------
    // Só filme/episódio avisam (trailer, música, TV ao vivo ficam de fora) e o mesmo início do usuário não
    // repete dentro da janela. Mesma filosofia das estreias da Echo: marca antes de falar — no pior caso
    // perde um aviso, nunca repete.
    if (eventType === 'PlaybackStart') {
        const tipoPlayback = String(item?.Type || payload.ItemType || '');
        if (tipoPlayback && !['Movie', 'Episode'].includes(tipoPlayback)) {
            console.log(`⏩ PlaybackStart de ${tipoPlayback} ignorado (só filme/episódio avisam).`);
            return;
        }
        const refItem = rawItemId || item?.Id || item?.ItemId || item?.Name || null;
        const chavePlay = `playback:${userName || '?'}:${refItem || '?'}`;
        let estadoPlay = {};
        try { estadoPlay = JSON.parse(fs.readFileSync(PLAYBACK_STATE_FILE, 'utf8')) || {}; } catch (_) { /* 1ª vez */ }
        const limitePlay = Date.now() - PLAYBACK_TTL_HORAS * 3600000;
        for (const k of Object.keys(estadoPlay)) if (!(estadoPlay[k] > limitePlay)) delete estadoPlay[k];
        if (estadoPlay[chavePlay]) {
            console.log(`⏩ PlaybackStart repetido de "${item?.Name || payload.Name || refItem}" (${userName || 'usuário ?'}) já avisado há menos de ${PLAYBACK_TTL_HORAS}h — sem aviso.`);
            return;
        }
        if (refItem) {
            estadoPlay[chavePlay] = Date.now();   // marca antes de avisar: no pior caso perde um aviso, nunca repete
            try { fs.writeFileSync(PLAYBACK_STATE_FILE, JSON.stringify(estadoPlay, null, 2)); } catch (e) { console.error(`⚠️ Falha ao salvar estado de reprodução: ${e.message}`); }
        }
    }

    if (eventType === 'UserDataSaved') {
        console.log(`⏩ Evento "${eventType}" ignorado (muito frequente).`);
        return;
    }
    if (eventType === 'PlaybackProgress') {
        console.log(`⏩ Evento "PlaybackProgress" ignorado (evita spam).`);
        return;
    }
    // Clipes do YouTube (biblioteca "Top 100 YouTube", /mnt/4tb/8.YOUTUBE) entram aos montes: sem aviso no WhatsApp/Echo
    const tipoItem = String(item?.Type || payload.ItemType || '');
    const caminhoItem = String(item?.Path || payload.Item?.Path || '');
    // exceto a biblioteca "Dramas Curtos" (14/10/2026): filmes/dramas pedidos um a um, esses são anunciados
    if (eventType === 'ItemAdded' && (tipoItem === 'MusicVideo' || (caminhoItem.includes('/8.YOUTUBE/') && !caminhoItem.includes('/8.YOUTUBE/Dramas Curtos/')))) {
        console.log(`⏩ ItemAdded de vídeo do YouTube ignorado: ${item?.Name || payload.Name || ''}`);
        return;
    }
    // Drama curto em episódios (subpasta em Dramas Curtos, "... - EP01.mp4" etc., 29/10/2026): anuncia só o EP01
    const epDramaCurto = caminhoItem.match(/\/8\.YOUTUBE\/Dramas Curtos\/[^/]+\/[^/]* - EP(\d+)\.[^/.]+$/);
    if (eventType === 'ItemAdded' && epDramaCurto && Number(epDramaCurto[1]) !== 1) {
        console.log(`⏩ ItemAdded de episódio de drama curto ignorado (só o EP01 é anunciado): ${item?.Name || payload.Name || ''}`);
        return;
    }
    // Músicas (biblioteca "Top 50 Brasil", /mnt/4tb/9.MUSICA) trocam toda semana: sem aviso no WhatsApp/Echo
    if (eventType === 'ItemAdded' && (['Audio', 'MusicAlbum', 'MusicArtist'].includes(tipoItem) || caminhoItem.includes('/9.MUSICA/'))) {
        console.log(`⏩ ItemAdded de música ignorado: ${item?.Name || payload.Name || ''}`);
        return;
    }

    console.log(`📌 Evento: ${eventType}`);
    if (item) console.log(`🎬 Item ID: ${item.Id || item.ItemId || 'não encontrado'}, Nome: ${item.Name || 'sem nome'}, Tipo: ${item.Type || '?'}`);

    let ehDoAnoAtual = true;
    if (eventType === 'ItemAdded' && item) {
        item = await aguardarItemReproduzivel(item, rawItemId || item.Id || item.ItemId);
        if (!item) return;
        await garantirSerieComEpisodios(item, rawItemId || item.Id || item.ItemId);
        item = await completarMetadadosPtBr(item, rawItemId || item.Id || item.ItemId);
        ehDoAnoAtual = await ehConteudoDoAnoAtual(item, rawItemId || item.Id || item.ItemId);
        item._notasImdb = await buscarNotasImdb(item, rawItemId || item.Id || item.ItemId);
        item._audioLegenda = await buscarInfoAudioLegenda(item, rawItemId || item.Id || item.ItemId);
        if (!ehDoAnoAtual && !JELLYFIN_TODOS_GROUP) return;
    }

    const messageKey = `${eventType}_${userName || ''}_${item?.Id || item?.ItemId || item?.Name || ''}`;
    // "Usuário autenticado": 1 aviso por usuário a cada 2 h, mesmo que ele entre várias vezes
    const ehAutenticacao = eventType === 'UserAuthenticated' || eventType === 'AuthenticationSuccess';
    const chaveAviso = eventType === 'SessionStart' ? `SessionStart_${userName || '?'}` : ehAutenticacao ? `Autenticado_${userName || '?'}` : messageKey;
    const cooldownSegundos = eventType === 'SessionStart' ? SESSION_COOLDOWN_SEGUNDOS : ehAutenticacao ? 2 * 3600 : 30;
    if (!shouldSendMessage(chaveAviso, cooldownSegundos)) {
        console.log(`⏸️ Mensagem duplicada ignorada (cooldown).`);
        return;
    }

    // Echo Dot: "ficou disponível no Jellyfin". Não bloqueia nem altera o envio para o WhatsApp abaixo.
    if (eventType === 'ItemAdded' && item) {
        try { registrarDisponivelNoJellyfin(item); } catch (echoErr) { console.error('❌ [Echo] Erro no aviso de item novo:', echoErr.message); }
    }

    let caption = null;
    let enviarComPoster = false;
    let itemId = null;

    if (eventosComPoster.includes(eventType) && item) {
        try {
            caption = buildRichMessage(eventType, item, userName, serverUrl, serverId, rawItemId);
        } catch (err) {
            console.error('⚠️ Erro ao montar mensagem rica, usando fallback JSON:', err);
            caption = `🔔 Evento: ${eventType}\nDados: ${JSON.stringify(item || payload).slice(0, 200)}`;
        }
        const extractedId = rawItemId || item.Id || item.ItemId;
        if (caption && extractedId) {
            enviarComPoster = true;
            itemId = extractedId;
            console.log(`🖼️ Preparando envio com poster para ${eventType} (ID: ${itemId})`);
        } else {
            console.log(`⚠️ Não foi possível obter ID do item para ${eventType}, enviando apenas texto.`);
        }
    } else {
        caption = buildSimpleMessage(eventType, payload, item, userName);
    }

    if (!caption) {
        console.log(`⏩ Nenhuma mensagem gerada para ${eventType}`);
        return;
    }

    // ItemAdded de filme: com ENABLE_SOLICITANTE_INPUT=true pergunta no terminal quem pediu; senão envia direto
    if (eventType === 'ItemAdded' && item && item.Type === 'Movie' && ENABLE_SOLICITANTE_INPUT) {
        enqueueItemAdded(item, caption, enviarComPoster ? itemId : null, enviarComPoster ? serverUrl : null, WHATSAPP_NUMBERS);
        console.log('📥 Filme adicionado à fila para solicitação de nome.');
        return;
    }

    const envios = [];
    const usarSistemaPrincipalNesteEvento = eventType === 'ServerStarted';

    if (usarSistemaPrincipalNesteEvento) {
        console.log(`📨 Encaminhando evento ${eventType} para o sistema principal em ${SISTEMA_MOBILE_URL}`);
        envios.push(enviarInicioJellyfinParaSistema(caption, payload));
    } else {
        // Grupo Jellyflix (antigo): só conteúdo do ano vigente
        if (WHATSAPP_NUMBERS.length > 0 && (eventType !== 'ItemAdded' || ehDoAnoAtual)) {
            console.log(`📤 Enviando para Jellyflix (${WHATSAPP_NUMBERS.length} destinatário(s))...`);
            envios.push(
                ...WHATSAPP_NUMBERS.map(num =>
                    enviarParaNumero(num, caption, enviarComPoster ? itemId : null, enviarComPoster ? serverUrl : null, enviarComPoster ? item : null)
                )
            );
        }
        // Grupo Jellyfin (novo): 100% de cobertura, todo ItemAdded
        if (JELLYFIN_TODOS_GROUP && eventType === 'ItemAdded') {
            const jaNoGrupoPrincipal = WHATSAPP_NUMBERS.includes(JELLYFIN_TODOS_GROUP);
            if (!jaNoGrupoPrincipal) {
                console.log(`📤 Enviando para Jellyfin (100%): ${JELLYFIN_TODOS_GROUP}`);
                envios.push(
                    enviarParaNumero(JELLYFIN_TODOS_GROUP, caption, enviarComPoster ? itemId : null, enviarComPoster ? serverUrl : null, enviarComPoster ? item : null)
                );
            }
        }
        if (envios.length === 0 && WHATSAPP_NUMBERS.length === 0 && !JELLYFIN_TODOS_GROUP) {
            console.log('⚠️ Nenhum destinatário configurado no WhatsApp.');
        }
    }

    if (envios.length === 0) {
        if (!usarSistemaPrincipalNesteEvento && eventType === 'ItemAdded' && !ehDoAnoAtual) {
            console.log(`⏩ ItemAdded de ano anterior, sem grupo "todos" configurado — aviso NÃO enviado.`);
        } else {
            console.log('⚠️ Nenhum canal de entrega configurado para este evento.');
        }
        return;
    }

    console.log(`💬 Mensagem: ${caption.replace(/\n/g, ' ').slice(0, 150)}...`);
    await Promise.allSettled(envios);

    console.log('✅ Processamento concluído.\n');
});

// ---------- REENVIO MANUAL DE AVISOS "NOVO CONTEÚDO" ----------
// POST {"ids":["<itemId>", ...]}: monta a mesma mensagem do ItemAdded e envia um por vez (sem Echo Dot).
app.post('/reenviar-item-added', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'informe ids' });
    res.json({ success: true, total: ids.length });
    let enviados = 0;
    for (const id of ids) {
        try {
            const base = await metadadosPtBr.jellyfinItemCompleto(id).catch(() => null);
            if (!base?.Type) { console.log(`⏩ [Reenvio] ${id} não encontrado no Jellyfin`); continue; }
            const item = await completarMetadadosPtBr(base, id);
            item._notasImdb = await buscarNotasImdb(item, id);
            item._audioLegenda = await buscarInfoAudioLegenda(item, id);
            const caption = buildRichMessage('ItemAdded', item, null, JELLYFIN_URL, JELLYFIN_SERVER_ID, id);
            for (const num of WHATSAPP_NUMBERS) {
                if (await enviarParaNumero(num, caption, id, JELLYFIN_URL, item)) enviados++;
            }
            await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
            console.error(`❌ [Reenvio] ${id}:`, err.message);
        }
    }
    console.log(`✅ [Reenvio] ${enviados}/${ids.length} aviso(s) de novo conteúdo reenviado(s).`);
});

// ---------- ROTAS PARA SONARR REMINDERS ----------
app.get('/sonarr-reminders/run', async (req, res) => {
    try {
        const dryRun = req.query.dryRun === '1';
        const result = await processSonarrReminders({ dryRun, trigger: dryRun ? 'manual-dry-run' : 'manual-run' });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/sonarr-reminders/status', (req, res) => {
    res.json({
        enabled: Boolean(SONARR_URL && SONARR_API_KEY && SONARR_RECIPIENTS.length > 0),
        sonarrUrl: SONARR_URL || null,
        recipients: SONARR_RECIPIENTS,
        reminderMinutesBefore: SONARR_REMINDER_MINUTES_BEFORE,
        pollIntervalMinutes: SONARR_POLL_INTERVAL_MINUTES,
        lookaheadMinutes: SONARR_LOOKAHEAD_MINUTES,
        stateFile: SONARR_STATE_FILE
    });
});

// Dublado = formato personalizado do Sonarr/Radarr; sem customFormatInfo, pelo nome do release
function releaseEhDublado(payload) {
    const formatos = (payload.customFormatInfo?.customFormats || []).map(cf => cf.name);
    return formatos.length > 0
        ? formatos.some(n => n === 'Dual PT-BR (título)' || n === 'PT-BR (idioma)') && !formatos.includes('Dual de outro idioma')
        : /dublad|nacional|pt-?br|brazilian|\bdual\b/i.test(payload.release?.releaseTitle || '');
}

// ---------- SONARR GRAB: AVISO PARTICULAR DE DOWNLOAD DE EPISÓDIO QUE TEVE LEMBRETE DE ESTREIA ----------
// Sonarr → Connect → Webhook (On Grab) → POST /sonarr-webhook
const SONARR_GRAB_WHATSAPP = process.env.SONARR_GRAB_WHATSAPP || '';

// Antes do aviso de "download iniciado", confere a lista de arquivos do torrent no qBittorrent com a mesma regra do
// bloquear_falsos.py (arquivos falsos .exe podem vir como episódios).
// Espera a lista aparecer (magnet sem metadados) por até GRAB_CONFERIR_MAX_MIN; falso → não avisa.
const GRAB_CONFERIR_INTERVALO_MS = 30 * 1000;
const GRAB_CONFERIR_MAX_MIN = parsePositiveInt(process.env.GRAB_CONFERIR_MAX_MIN, 20);
// Opcional: script seu que confere os arquivos de um torrent no qBittorrent e imprime JSON {veredito: video|falso|pendente|ausente}
const BLOQUEAR_FALSOS_PY = process.env.BLOQUEAR_FALSOS_PY || '';

function vereditoTorrent(hash) {
    return new Promise(resolve => {
        if (!BLOQUEAR_FALSOS_PY || !fs.existsSync(BLOQUEAR_FALSOS_PY)) return resolve({ veredito: 'video' });   // sem conferência: avisa normalmente
        require('child_process').execFile('python3', [BLOQUEAR_FALSOS_PY, '--conferir', hash], { timeout: 120000 },
            (err, stdout) => {
                try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
                catch (_) { resolve({ veredito: 'erro', detalhe: err ? err.message : String(stdout).slice(0, 200) }); }
            });
    });
}

// → { veredito: 'video'|'falso'|'pendente'|'ausente'|'erro'|'sem_hash', arquivo? }
async function conferirArquivosDoGrab(downloadId, rotulo) {
    if (!downloadId) return { veredito: 'sem_hash' };
    const limite = Date.now() + GRAB_CONFERIR_MAX_MIN * 60000;
    let r;
    do {
        await new Promise(resolve => setTimeout(resolve, GRAB_CONFERIR_INTERVALO_MS));
        r = await vereditoTorrent(downloadId);
        if (['video', 'falso', 'ausente'].includes(r.veredito)) break;
    } while (Date.now() < limite);
    console.log(`🛡️ [Grab] ${rotulo}: arquivos ${r.veredito}${r.arquivo ? ` (${r.arquivo})` : ''}`);
    return r;
}

app.post('/sonarr-webhook', async (req, res) => {
    res.status(200).send('OK');
    const payload = req.body || {};
    if (payload.eventType === 'Test') {
        console.log('🧪 [Sonarr Grab] Teste recebido do Sonarr.');
        return;
    }
    if (payload.eventType !== 'Grab' || !Array.isArray(payload.episodes)) return;

    const release = payload.release || {};
    const dublado = releaseEhDublado(payload);

    // 1º download de cada episódio com lembrete de estreia; depois, mais um aviso quando chegar o dublado
    const sent = sonarrReminderState.sent || {};
    const avisados = payload.episodes.filter(ep =>
        Object.keys(sent).some(key => key.startsWith(`${ep.id}:`)) &&
        (!sent[`grab:${ep.id}`] || (dublado && !sent[`grabdub:${ep.id}`]))
    );
    if (avisados.length === 0) return;

    const seriesTitle = payload.series?.title || 'Série';
    const codigos = avisados.map(ep => `${buildSonarrEpisodeCode(ep)}${ep.title ? `: ${ep.title}` : ''}`).join('\n🎞️ ');
    const tamanho = release.size ? ` (${(release.size / 1024 ** 3).toFixed(2)} GB)` : '';
    const jaAvisado = avisados.every(ep => sent[`grab:${ep.id}`]);

    const rotulo = `${seriesTitle} ${avisados.map(buildSonarrEpisodeCode).join(', ')}`;
    const conferencia = await conferirArquivosDoGrab(payload.downloadId, rotulo);
    if (['falso', 'ausente'].includes(conferencia.veredito)) {
        // falso: o bloquear_falsos.py (cron */10) tira da fila e o Sonarr busca outro; ausente: já foi removido
        console.log(`⏩ [Sonarr Grab] ${rotulo}: aviso NÃO enviado (${conferencia.veredito})`);
        return;
    }

    let message = jaAvisado
        ? `🇧🇷 *Chegou a versão dublada do episódio que acabou de estrear*\n\n`
        : `⬇️ *Download iniciado de episódio que acabou de estrear*${dublado ? ' (dublado 🇧🇷)' : ''}\n\n`;
    message += `📺 *${seriesTitle}*\n`;
    message += `🎞️ ${codigos}\n`;
    if (release.releaseTitle) message += `📦 ${release.releaseTitle}${tamanho}\n`;
    if (release.indexer) message += `🔎 ${release.indexer}\n`;
    message += conferencia.veredito === 'video'
        ? `✅ Arquivo conferido: ${conferencia.arquivo}`
        : `⚠️ Arquivos ainda não conferidos (torrent sem metadados)`;

    const ok = await enviarParaNumero(SONARR_GRAB_WHATSAPP, message.trim());
    console.log(`${ok ? '✅' : '❌'} [Sonarr Grab] ${seriesTitle} ${avisados.map(buildSonarrEpisodeCode).join(', ')}${dublado ? ' (dublado)' : ''} → ${SONARR_GRAB_WHATSAPP}`);
    if (ok) {
        const agora = new Date().toISOString();
        for (const ep of avisados) {
            sent[`grab:${ep.id}`] = sent[`grab:${ep.id}`] || agora;
            if (dublado) sent[`grabdub:${ep.id}`] = agora;
        }
        sonarrReminderState.sent = sent;
        saveSonarrReminderState();
    }
});

// ---------- RADARR GRAB: AVISO PARTICULAR DE DOWNLOAD DE FILME QUE TEVE AVISO DE LANÇAMENTO DIGITAL ----------
// Radarr → Connect → Webhook (On Grab) → POST /radarr-webhook
// O aviso de lançamento digital é do sistema-mobile-3004.js (radarr_digital_state.json, chave Radarr_movie_<id>_digital).
const RADARR_DIGITAL_STATE_FILE = path.join(__dirname, 'radarr_digital_state.json');
const RADARR_GRAB_STATE_FILE = path.join(__dirname, 'radarr-grab-state.json');
const RADARR_GRAB_JANELA_MS = 30 * 24 * 60 * 60 * 1000;   // dublado de filme costuma demorar mais que o de série
const RADARR_GRAB_RETENCAO_MS = 60 * 24 * 60 * 60 * 1000;

app.post('/radarr-webhook', async (req, res) => {
    res.status(200).send('OK');
    const payload = req.body || {};
    if (payload.eventType === 'Test') {
        console.log('🧪 [Radarr Grab] Teste recebido do Radarr.');
        return;
    }
    const filme = payload.movie;
    if (payload.eventType !== 'Grab' || !filme?.id) return;

    let digital = {};
    let estado = {};
    try { digital = JSON.parse(fs.readFileSync(RADARR_DIGITAL_STATE_FILE, 'utf8')) || {}; } catch (_) { /* sem avisos ainda */ }
    try { estado = JSON.parse(fs.readFileSync(RADARR_GRAB_STATE_FILE, 'utf8')) || {}; } catch (_) { /* primeiro uso */ }

    const avisoDigital = Date.parse(digital[`Radarr_movie_${filme.id}_digital`]?.notifiedAt);
    if (!Number.isFinite(avisoDigital) || Date.now() - avisoDigital > RADARR_GRAB_JANELA_MS) return;

    const dublado = releaseEhDublado(payload);
    const jaAvisado = Boolean(estado[`grab:${filme.id}`]);
    if (jaAvisado && (!dublado || estado[`grabdub:${filme.id}`])) return;

    const release = payload.release || {};
    const tamanho = release.size ? ` (${(release.size / 1024 ** 3).toFixed(2)} GB)` : '';
    const conferencia = await conferirArquivosDoGrab(payload.downloadId, filme.title);
    if (['falso', 'ausente'].includes(conferencia.veredito)) {
        console.log(`⏩ [Radarr Grab] ${filme.title}: aviso NÃO enviado (${conferencia.veredito})`);
        return;
    }
    let message = jaAvisado
        ? `🇧🇷 *Chegou a versão dublada do filme que acabou de lançar no digital*\n\n`
        : `⬇️ *Download iniciado de filme que acabou de lançar no digital*${dublado ? ' (dublado 🇧🇷)' : ''}\n\n`;
    message += `🎬 *${filme.title}*${filme.year ? ` (${filme.year})` : ''}\n`;
    if (release.releaseTitle) message += `📦 ${release.releaseTitle}${tamanho}\n`;
    if (release.indexer) message += `🔎 ${release.indexer}\n`;
    message += conferencia.veredito === 'video'
        ? `✅ Arquivo conferido: ${conferencia.arquivo}`
        : `⚠️ Arquivos ainda não conferidos (torrent sem metadados)`;

    const ok = await enviarParaNumero(SONARR_GRAB_WHATSAPP, message.trim());
    console.log(`${ok ? '✅' : '❌'} [Radarr Grab] ${filme.title}${dublado ? ' (dublado)' : ''} → ${SONARR_GRAB_WHATSAPP}`);
    if (ok) {
        const agora = Date.now();
        estado[`grab:${filme.id}`] = estado[`grab:${filme.id}`] || agora;
        if (dublado) estado[`grabdub:${filme.id}`] = agora;
        for (const k of Object.keys(estado)) if (!(agora - estado[k] < RADARR_GRAB_RETENCAO_MS)) delete estado[k];
        try { fs.writeFileSync(RADARR_GRAB_STATE_FILE, JSON.stringify(estado, null, 2)); } catch (e) { console.error(`⚠️ [Radarr Grab] Falha ao salvar estado: ${e.message}`); }
    }
});

// ---------- ECHO DOT: ESTREIAS (Sonarr/Radarr) E DISPONIBILIDADE (Jellyfin) ----------
// Dois momentos falados pela Echo, via o mesmo webhook do Home Assistant do bot de WhatsApp (HA_WEBHOOK_URL, que
// monta a frase "<contato> <mensagem>" para tipo != "texto"):
//   1) ESTREIA: no instante da estreia. Um agendador consulta o calendário do Sonarr (airDateUtc, com horário exato)
//      e do Radarr (só tem DATA, sem horário: a fala sai às ECHO_FILME_HORA do dia; padrão 22:00) a cada 30 s.
//   2) DISPONÍVEL: o Jellyfin publicou o item na biblioteca (ItemAdded, dentro de /jellyfin-webhook).
// Só séries/filmes MONITORADOS. Desligar tudo: ECHO_MIDIA=off no .env. Rajadas (temporada inteira) são agrupadas.
const ECHO_MIDIA_URL = String(process.env.HA_WEBHOOK_URL || '').trim();
const ECHO_MIDIA_ATIVA = Boolean(ECHO_MIDIA_URL) && !/^(off|false|0|nao|não)$/i.test(String(process.env.ECHO_MIDIA || '').trim());
const ECHO_MIDIA_MAX_FALAS = 3;   // mais grupos que isso viram um resumo só
const ECHO_TZ = process.env.TZ || 'America/Sao_Paulo';
const ECHO_ESTREIA_INTERVALO_MS = Number(process.env.ECHO_ESTREIA_INTERVALO_MS) || 30000;
const ECHO_EPISODIO_TOLERANCIA_MS = 20 * 60 * 1000;        // bridge fora do ar na hora: ainda fala até 20 min depois
const ECHO_FILME_TOLERANCIA_MS = 12 * 60 * 60 * 1000;      // filme só tem data: fala até 12 h depois do horário-padrão
const ECHO_FILME_HORA = /^\d{1,2}:\d{2}$/.test(String(process.env.ECHO_FILME_HORA || '').trim()) ? String(process.env.ECHO_FILME_HORA).trim() : '22:00';
const ECHO_CAMPO_FILME = { cinema: 'inCinemas', digital: 'digitalRelease', fisico: 'physicalRelease' };
const ECHO_FILME_DATAS = String(process.env.ECHO_FILME_DATAS || 'cinema,digital').split(',').map((x) => x.trim().toLowerCase()).filter((x) => ECHO_CAMPO_FILME[x]);
const ECHO_ESTREIA_STATE_FILE = process.env.ECHO_ESTREIA_STATE_FILE || path.join(__dirname, 'echo-estreias-state.json');
const ECHO_ESTADO_RETENCAO_MS = 14 * 24 * 60 * 60 * 1000;
const RADARR_URL = String(process.env.RADARR_URL || '').trim().replace(/\/+$/, '');
const RADARR_API_KEY = String(process.env.RADARR_API_KEY || '').trim();

function tituloMidiaParaFala(texto) {
    return String(texto || '').replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function falarMidiaNaEcho(contato, mensagem) {
    const resposta = await fetch(ECHO_MIDIA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contato, mensagem, tipo: 'midia' }),
        signal: AbortSignal.timeout(5000)
    });
    if (!resposta.ok) throw new Error(`Home Assistant respondeu HTTP ${resposta.status}`);
}

// Um item = { tipo: 'episodio'|'filme', titulo, temporada?, episodio?, episodios?: n, lancamento?: 'cinema'|'digital'|'fisico' }
// A estreia é falada quase na hora (janela curta: tudo de um mesmo instante chega junto); o "disponível" espera mais,
// porque o Jellyfin importa uma temporada inteira aos poucos.
const ECHO_MIDIA_CANAIS = {
    lancado:    { contato: (origem) => origem, janelaMs: 3000,  janelaMaxMs: 15000 },
    disponivel: { contato: () => 'Jellyfin',   janelaMs: 20000, janelaMaxMs: 60000 }
};

function fraseFilmeLancado(titulo, lancamento) {
    if (lancamento === 'cinema') return `informa que acaba de estrear nos cinemas o filme: ${titulo}.`;
    if (lancamento === 'fisico') return `informa que acaba de ser lançado em mídia física o filme: ${titulo}.`;
    return `informa que acaba de ser lançado em digital o filme: ${titulo}.`;
}

function frasesDoLote(canal, itens) {
    const lancado = canal === 'lancado';
    // agrupa episódios da mesma série; cada filme (por tipo de lançamento) fica sozinho
    const grupos = new Map();
    for (const it of itens) {
        const chave = it.tipo === 'filme' ? `filme|${it.titulo}|${it.lancamento || ''}` : `serie|${it.titulo}`;
        const g = grupos.get(chave) || { tipo: it.tipo, titulo: it.titulo, lancamento: it.lancamento, episodios: 0, temporadas: new Set(), ultimoEp: null };
        g.episodios += it.tipo === 'filme' ? 1 : (it.episodios || 1);
        if (it.temporada !== undefined && it.temporada !== null) g.temporadas.add(it.temporada);
        if (it.tipo === 'episodio' && (it.episodios || 1) === 1) g.ultimoEp = it.episodio;
        grupos.set(chave, g);
    }
    const lista = [...grupos.values()];
    if (lista.length > ECHO_MIDIA_MAX_FALAS) {
        const total = itens.reduce((n, it) => n + (it.tipo === 'filme' ? 1 : (it.episodios || 1)), 0);
        return [lancado ? `informa que acabam de estrear ${total} novos itens` : `disponibilizou ${total} novos itens`];
    }
    return lista.map((g) => {
        if (g.tipo === 'filme') return lancado ? fraseFilmeLancado(g.titulo, g.lancamento) : `disponibilizou um novo filme: ${g.titulo}.`;
        const temp = g.temporadas.size === 1 ? [...g.temporadas][0] : null;
        if (g.episodios === 1) {
            const partes = [g.titulo];
            if (temp !== null) partes.push(`temporada ${temp}`);
            if (g.ultimoEp !== null && g.ultimoEp !== undefined) partes.push(`episódio ${g.ultimoEp}`);
            return `${lancado ? 'informa que acaba de estrear um novo episódio' : 'disponibilizou um novo episódio'}: ${partes.join(', ')}.`;
        }
        const sufixo = `${g.titulo}${temp !== null ? `, temporada ${temp}` : ''}`;
        return lancado ? `informa que acabam de estrear ${g.episodios} novos episódios de ${sufixo}.` : `disponibilizou ${g.episodios} novos episódios de ${sufixo}.`;
    });
}

const echoLotes = new Map();   // "canal|origem" -> { itens, inicio, timer }

function agendarFalaMidia(canal, origem, item) {
    if (!ECHO_MIDIA_ATIVA || !item || !item.titulo) return;
    const cfg = ECHO_MIDIA_CANAIS[canal];
    const janela = Number(process.env.ECHO_MIDIA_JANELA_MS) || cfg.janelaMs;
    const janelaMax = Number(process.env.ECHO_MIDIA_JANELA_MAX_MS) || cfg.janelaMaxMs;
    const chave = `${canal}|${origem}`;
    const lote = echoLotes.get(chave) || { itens: [], inicio: Date.now(), timer: null };
    lote.itens.push(item);
    clearTimeout(lote.timer);
    const restante = Math.max(0, janelaMax - (Date.now() - lote.inicio));
    lote.timer = setTimeout(() => descarregarLoteMidia(chave), Math.min(janela, restante));
    echoLotes.set(chave, lote);
}

async function descarregarLoteMidia(chave) {
    const lote = echoLotes.get(chave);
    echoLotes.delete(chave);
    if (!lote || lote.itens.length === 0) return;
    const [canal, origem] = chave.split('|');
    const contato = ECHO_MIDIA_CANAIS[canal].contato(origem);
    for (const frase of frasesDoLote(canal, lote.itens)) {
        try {
            await falarMidiaNaEcho(contato, frase);
            console.log(`🔊 [Echo] ${contato}: ${frase}`);
        } catch (err) {
            console.error(`❌ [Echo] Não consegui falar (${err.message}).`);
        }
    }
}

// Jellyfin ItemAdded: só episódio e filme (série e temporada também disparam ItemAdded e repetiriam a fala).
function registrarDisponivelNoJellyfin(item) {
    if (!ECHO_MIDIA_ATIVA || !item) return;
    const tipo = String(item.Type || item.ItemType || '');
    if (tipo === 'Movie') {
        agendarFalaMidia('disponivel', 'Jellyfin', { tipo: 'filme', titulo: tituloMidiaParaFala(item.Name) });
    } else if (tipo === 'Episode') {
        const temporada = item.SeasonNumber ?? item.ParentIndexNumber;
        const episodio = item.EpisodeNumber ?? item.IndexNumber;
        agendarFalaMidia('disponivel', 'Jellyfin', {
            tipo: 'episodio',
            titulo: tituloMidiaParaFala(item.SeriesName || item.Name),
            temporada: temporada === undefined || temporada === null || temporada === '' ? null : Number(temporada),
            episodio: episodio === undefined || episodio === null || episodio === '' ? null : Number(episodio)
        });
    }
}

// ----- ESTREIAS: calendário do Sonarr/Radarr -----
// Diferença entre o relógio de parede de um fuso e o UTC naquele instante (em ms).
function offsetDoFusoMs(instanteMs, tz) {
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(instanteMs)).map((x) => [x.type, x.value]));
    return Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second) - Math.floor(instanteMs / 1000) * 1000;
}

// "2026-09-23" + "09:00" no fuso tz -> instante UTC em ms
function horaLocalParaInstante(ymd, hhmm, tz) {
    const [y, m, d] = ymd.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    const comoUtc = Date.UTC(y, m - 1, d, hh, mm);
    let instante = comoUtc - offsetDoFusoMs(comoUtc, tz);
    instante = comoUtc - offsetDoFusoMs(instante, tz);   // corrige nas viradas de horário de verão
    return instante;
}

// O Radarr manda "2026-09-23T00:00:00Z" (só data). Se vier um horário de verdade, usa; senão, ECHO_FILME_HORA local.
function instanteDaDataDoFilme(iso) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    if (m[2] !== '00:00:00') return Date.parse(iso);
    return horaLocalParaInstante(m[1], ECHO_FILME_HORA, ECHO_TZ);
}

// Puro (sem rede nem arquivo): o que já chegou a hora de falar e ainda não foi falado.
function estreiasPendentes({ agora, episodios = [], filmes = [], jaFalados = {} }) {
    const saida = [];
    for (const e of episodios) {
        if (e.monitored === false || !(Number(e.seasonNumber) > 0)) continue;   // temporada 0 = especiais, fora
        const t = Date.parse(e.airDateUtc);
        if (!Number.isFinite(t) || t > agora || agora - t > ECHO_EPISODIO_TOLERANCIA_MS) continue;
        const chave = `sonarr:${e.id}`;
        const titulo = tituloMidiaParaFala(e.series?.title || e.seriesTitle);
        if (jaFalados[chave] || !titulo) continue;
        saida.push({ chave, origem: 'Sonarr', item: { tipo: 'episodio', titulo, temporada: Number(e.seasonNumber), episodio: Number(e.episodeNumber), episodios: 1 } });
    }
    for (const f of filmes) {
        if (f.monitored === false) continue;
        const titulo = tituloMidiaParaFala(f.title);
        if (!titulo) continue;
        for (const tipo of ECHO_FILME_DATAS) {
            const t = instanteDaDataDoFilme(f[ECHO_CAMPO_FILME[tipo]]);
            if (t === null || t > agora || agora - t > ECHO_FILME_TOLERANCIA_MS) continue;
            const chave = `radarr:${f.id}:${tipo}`;
            if (jaFalados[chave]) continue;
            saida.push({ chave, origem: 'Radarr', item: { tipo: 'filme', titulo, lancamento: tipo } });
        }
    }
    return saida;
}

function carregarEstadoEstreias() {
    try { return JSON.parse(fs.readFileSync(ECHO_ESTREIA_STATE_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

function salvarEstadoEstreias(estado) {
    const limite = Date.now() - ECHO_ESTADO_RETENCAO_MS;
    for (const k of Object.keys(estado)) if (!(estado[k] > limite)) delete estado[k];
    try { fs.writeFileSync(ECHO_ESTREIA_STATE_FILE, JSON.stringify(estado)); } catch (e) { console.error(`❌ [Echo] Não consegui salvar o estado das estreias: ${e.message}`); }
}

async function buscarCalendarioArr(baseUrl, apiKey, inicioMs, fimMs, extra = '') {
    const url = `${baseUrl}/api/v3/calendar?start=${encodeURIComponent(new Date(inicioMs).toISOString())}&end=${encodeURIComponent(new Date(fimMs).toISOString())}&unmonitored=false${extra}`;
    const resposta = await fetch(url, { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(10000) });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const dados = await resposta.json();
    return Array.isArray(dados) ? dados : [];
}

let echoEstreiaEmAndamento = false;
const echoErroLogadoEm = {};   // evita repetir o mesmo erro a cada 30 s

async function verificarEstreiasParaEcho() {
    if (echoEstreiaEmAndamento) return 0;
    echoEstreiaEmAndamento = true;
    try {
        const agora = Date.now();
        let episodios = [];
        let filmes = [];
        const registrarErro = (quem, err) => {
            if (Date.now() - (echoErroLogadoEm[quem] || 0) > 10 * 60 * 1000) {
                echoErroLogadoEm[quem] = Date.now();
                console.error(`❌ [Echo] Calendário do ${quem} indisponível (${err.message}); continuo tentando.`);
            }
        };
        if (SONARR_URL && SONARR_API_KEY) {
            try { episodios = await buscarCalendarioArr(SONARR_URL, SONARR_API_KEY, agora - ECHO_EPISODIO_TOLERANCIA_MS - 60000, agora + 60000, '&includeSeries=true'); }
            catch (err) { registrarErro('Sonarr', err); }
        }
        if (RADARR_URL && RADARR_API_KEY) {
            try { filmes = await buscarCalendarioArr(RADARR_URL, RADARR_API_KEY, agora - 36 * 3600 * 1000, agora + 36 * 3600 * 1000); }
            catch (err) { registrarErro('Radarr', err); }
        }
        const estado = carregarEstadoEstreias();
        const pendentes = estreiasPendentes({ agora, episodios, filmes, jaFalados: estado });
        if (pendentes.length === 0) return 0;
        for (const p of pendentes) {
            estado[p.chave] = agora;   // marca antes de falar: no pior caso perde um aviso, nunca repete
            agendarFalaMidia('lancado', p.origem, p.item);
        }
        salvarEstadoEstreias(estado);
        console.log(`🎬 [Echo] ${pendentes.length} estreia(s) chegou/chegaram na hora.`);
        return pendentes.length;
    } finally {
        echoEstreiaEmAndamento = false;
    }
}

function iniciarEstreiasNaEcho() {
    if (!ECHO_MIDIA_ATIVA) return console.log('🔇 Echo Dot (mídia): desativada (falta HA_WEBHOOK_URL ou ECHO_MIDIA=off).');
    const fontes = [SONARR_URL && SONARR_API_KEY ? 'Sonarr (horário exato)' : null, RADARR_URL && RADARR_API_KEY ? `Radarr (${ECHO_FILME_DATAS.join('+')} às ${ECHO_FILME_HORA})` : null].filter(Boolean);
    if (fontes.length === 0) return console.log('⚠️ Echo Dot (estreias): configure SONARR_URL/SONARR_API_KEY e/ou RADARR_URL/RADARR_API_KEY.');
    console.log(`🔊 Echo Dot: estreias de ${fontes.join(' e ')}, a cada ${Math.round(ECHO_ESTREIA_INTERVALO_MS / 1000)} s; disponível: Jellyfin ItemAdded.`);
    const tick = () => verificarEstreiasParaEcho().catch((e) => console.error(`❌ [Echo] Erro na varredura de estreias: ${e.message}`));
    setTimeout(tick, 15000);
    setInterval(tick, ECHO_ESTREIA_INTERVALO_MS);
}

// ---------- JELLYFLIX NO WHATSAPP (comandos no grupo, enquete do Filme da Sexta, avisos e resumos) ----------
// Lógica em jellyflix-whatsapp.js; o whatsapp-bot.js repassa as mensagens dos grupos de JELLYFLIX_WHATS_GRUPOS.
// Módulo opcional (não incluído nesta versão pública): comandos do grupo, enquetes e resumos.
try {
    const jellyflixWhats = require('./jellyflix-whatsapp').criarJellyflixWhats();
    jellyflixWhats.rotas(app);
    jellyflixWhats.iniciar();
} catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    console.log('ℹ️ jellyflix-whatsapp.js ausente: comandos de grupo desativados.');
}

// ---------- INICIALIZAÇÃO ----------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌉 Bridge Jellyfin → WhatsApp rodando em http://localhost:${PORT}`);
    console.log(`📌 Endpoint: http://localhost:${PORT}/jellyfin-webhook`);
    console.log(`🔁 Enviará notificações para: ${WHATSAPP_NUMBERS.join(', ') || '(nenhum)'}`);
    if (JELLYFIN_TODOS_GROUP) console.log(`📢 Grupo Jellyfin (100% cobertura): ${JELLYFIN_TODOS_GROUP}`);
    console.log(`🔄 Cooldown de 30s para mensagens repetidas.`);
    if (JELLYFIN_API_KEY) console.log(`✅ API Jellyfin ativa - busca de dados completos disponível`);
    else console.log(`⚠️ JELLYFIN_API_KEY não configurada - funcionalidade limitada`);
    console.log(`🖼️ Posters enviados para: ItemAdded, PlaybackStart`);
    console.log(`🔍 Fallback de imagens: Jellyfin → Série → OMDb (IMDb) → TMDB (ID/título) → URL padrão → Placeholder PNG (sharp) → SVG`);
    console.log(`🔄 Retry em chamadas de rede e fila de reenvio para ATSAPP ativados.`);
    console.log(`🔕 Eventos ignorados: UserDataSaved, PlaybackProgress, PlaybackStop`);
    console.log(`▶️ Reprodução: 1 anúncio por filme/episódio iniciado (${PLAYBACK_TTL_HORAS}h, ${PLAYBACK_STATE_FILE}); parada nunca avisa.`);
    console.log(`🌐 Links no WhatsApp usam: ${PUBLIC_JELLYFIN_URL}`);
    console.log(`🆔 ServerId usado nos links: ${JELLYFIN_SERVER_ID || '(do payload)'}`);
    console.log(`📨 Integração com sistema principal: ${SISTEMA_MOBILE_URL}`);
    console.log(`📺 Endpoint Sonarr: http://localhost:${PORT}/sonarr-reminders/run`);
    console.log(`📘 Status Sonarr: http://localhost:${PORT}/sonarr-reminders/status`);
    startSonarrReminderScheduler();
    iniciarEstreiasNaEcho();
    startUserFilterSyncScheduler();
});

process.on('uncaughtException', (err) => {
    console.error('❌ Exceção não capturada no bridge:', err);
});
