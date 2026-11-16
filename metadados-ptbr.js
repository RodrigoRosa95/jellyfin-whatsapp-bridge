// Metadados em PT-BR no Jellyfin: identifica filmes/séries (Radarr/Sonarr → IDs do Jellyfin → busca TMDB),
// completa título, sinopse, slogan, gêneros, classificação, estúdios, estreia, nota, capa e fundo, e nos
// episódios título/sinopse/numeração/imagem. Quando o TMDB não tem o texto em PT-BR, o Claude traduz do inglês.
// Usado pelo bridge.js (aviso de item novo) e por varreduras completas.
// Requer o .env já carregado (dotenv) antes do require.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const JELLYFIN_URL = (process.env.METADADOS_JELLYFIN_URL || process.env.JELLYFIN_URL || 'http://127.0.0.1:8096').replace(/\/+$/, '');
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const RADARR_URL = String(process.env.RADARR_URL || '').trim().replace(/\/+$/, '');
const RADARR_API_KEY = String(process.env.RADARR_API_KEY || '').trim();
const SONARR_URL = String(process.env.SONARR_URL || '').trim().replace(/\/+$/, '');
const SONARR_API_KEY = String(process.env.SONARR_API_KEY || '').trim();
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude');
const CLAUDE_MODELO = process.env.CLAUDE_MODELO_SINOPSE || 'opus';
try { require('fs').mkdirSync(path.join(os.homedir(), '.cache', 'jellyfin-bridge'), { recursive: true }); } catch (_) { /* sem cache */ }
const CUSTOS_CLAUDE_FILE = path.join(os.homedir(), '.cache', 'jellyfin-bridge', 'custos-claude.jsonl');
const ESPERA_IDENTIFICACAO_MS = 120000;

let simulacao = false;           // true: não grava nada no Jellyfin (--dry-run)
let jellyfinAdminId = null;
const arrCache = new Map();
const tmdbCache = new Map();

function setSimulacao(valor) { simulacao = !!valor; }

async function fetchRetry(url, opcoes = {}, tentativas = 3) {
    let ultimoErro;
    for (let i = 0; i < tentativas; i++) {
        try {
            const resp = await fetch(url, { ...opcoes, signal: AbortSignal.timeout(60000) });
            if (resp.ok || [400, 401, 403, 404].includes(resp.status) || i === tentativas - 1) return resp;
            ultimoErro = new Error(`HTTP ${resp.status}`);
        } catch (err) {
            ultimoErro = err;
        }
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
    throw ultimoErro;
}

// ---------- JELLYFIN ----------
async function jellyfinJson(caminho, opcoes = {}) {
    const resp = await fetchRetry(`${JELLYFIN_URL}${caminho}`, {
        ...opcoes,
        headers: { 'X-Emby-Token': JELLYFIN_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Jellyfin ${caminho.split('?')[0]}: HTTP ${resp.status}`);
    const texto = await resp.text();
    return texto ? JSON.parse(texto) : null;
}

async function jellyfinItemCompleto(itemId) {
    if (!jellyfinAdminId) {
        const usuarios = await jellyfinJson('/Users');
        jellyfinAdminId = (usuarios.find(u => u.Policy?.IsAdministrator) || usuarios[0]).Id;
    }
    return jellyfinJson(`/Items/${itemId}?userId=${jellyfinAdminId}`);
}

async function gravarItem(novo) {
    if (simulacao) return;
    await jellyfinJson(`/Items/${novo.Id}`, { method: 'POST', body: JSON.stringify(novo) });
}

async function baixarImagemNoJellyfin(itemId, tipo, url) {
    if (!url) return false;
    if (simulacao) return true;
    try {
        await jellyfinJson(`/Items/${itemId}/RemoteImages/Download?type=${tipo}&imageUrl=${encodeURIComponent(url)}`, { method: 'POST' });
        return true;
    } catch (err) {
        console.log(`⚠️ [Metadados] Falha ao gravar imagem ${tipo}: ${err.message}`);
        return false;
    }
}

// ---------- TMDB ----------
async function tmdbJson(caminho, params = {}) {
    const qs = new URLSearchParams({ api_key: TMDB_API_KEY, language: 'pt-BR', ...params });
    const url = `https://api.themoviedb.org/3${caminho}?${qs}`;
    if (tmdbCache.has(url)) return tmdbCache.get(url);
    const resp = await fetchRetry(url, {}, 2);
    if (!resp.ok) throw new Error(`TMDB ${caminho}: HTTP ${resp.status}`);
    const dados = await resp.json();
    if (tmdbCache.size > 2000) tmdbCache.clear();
    tmdbCache.set(url, dados);
    return dados;
}

const IMG = (p) => (p ? `https://image.tmdb.org/t/p/original${p}` : null);

// Melhor imagem do TMDB: português primeiro, depois sem texto, depois inglês; desempate pelos votos
function melhorImagemTmdb(lista, preferirSemTexto = false) {
    const ordem = preferirSemTexto ? [null, 'pt', 'en'] : ['pt', null, 'en'];
    for (const idioma of ordem) {
        const doIdioma = (lista || []).filter(i => (i.iso_639_1 || null) === idioma)
            .sort((a, b) => (b.vote_average - a.vote_average) || (b.vote_count - a.vote_count));
        if (doIdioma.length) return IMG(doIdioma[0].file_path);
    }
    return lista?.[0] ? IMG(lista[0].file_path) : null;
}

function classificacaoBrasil(detalhes, tipoTmdb) {
    if (tipoTmdb === 'movie') {
        const br = detalhes.release_dates?.results?.find(r => r.iso_3166_1 === 'BR');
        const cert = br?.release_dates?.map(d => d.certification).find(Boolean);
        return cert ? `BR-${cert}` : null;
    }
    const br = detalhes.content_ratings?.results?.find(r => r.iso_3166_1 === 'BR');
    return br?.rating ? `BR-${br.rating}` : null;
}

// ---------- RADARR / SONARR ----------
async function listaArr(url, chave, recurso) {
    if (!url || !chave) return [];
    const cache = arrCache.get(recurso);
    if (cache && Date.now() - cache.quando < 600000) return cache.dados;
    try {
        const resp = await fetchRetry(`${url}/api/v3/${recurso}`, { headers: { 'X-Api-Key': chave } }, 2);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const dados = await resp.json();
        arrCache.set(recurso, { quando: Date.now(), dados });
        return dados;
    } catch (err) {
        console.log(`⚠️ [Metadados] Falha ao listar ${recurso} do ${url}: ${err.message}`);
        return cache ? cache.dados : [];
    }
}

const semBarraFinal = (p) => String(p || '').replace(/\/+$/, '');

// IDs que o Radarr/Sonarr têm para a pasta do item (são os mais confiáveis: foram eles que baixaram)
async function idsDoArr(item) {
    const caminho = semBarraFinal(item.Path);
    if (!caminho) return null;
    if (item.Type === 'Movie') {
        const pasta = path.dirname(caminho);
        const filme = (await listaArr(RADARR_URL, RADARR_API_KEY, 'movie'))
            .find(m => semBarraFinal(m.path) === pasta || semBarraFinal(m.path) === caminho);
        return filme ? { Tmdb: filme.tmdbId, Imdb: filme.imdbId } : null;
    }
    const serie = (await listaArr(SONARR_URL, SONARR_API_KEY, 'series'))
        .find(s => s.path && (caminho === semBarraFinal(s.path) || caminho.startsWith(semBarraFinal(s.path) + '/')));
    return serie ? { Tmdb: serie.tmdbId, Tvdb: serie.tvdbId, Imdb: serie.imdbId } : null;
}

// ---------- TEXTO ----------
const normalizar = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function parecido(a, b) {
    const na = normalizar(a), nb = normalizar(b);
    if (!na || !nb) return false;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
    const comuns = [...ta].filter(t => tb.has(t)).length;
    return comuns / Math.min(ta.size, tb.size) >= 0.5;
}

const ehTituloGenerico = (t) => !t || /^(Episódio|Episodio|Episode|Capítulo|Capitulo|Ep\.?)\s*\d+$/i.test(String(t).trim());

const MARCAS_DE_ARQUIVO = /S\d{1,2}\s*E\d{1,3}|\bT\d{1,2}\s*E\d{1,3}|\b\d{1,2}x\s*\(?\d{1,3}\)?|\b\d{1,2}E\d{2,3}\b|\b(480p|720p|1080p|2160p|WEB-?DL|WEBRip|BluRay|HDTV|x264|x265|HEVC|Dublado|Dual|FULL HD)\b|\.(mov|mpeg|mkv|mp4|avi)$/i;
const pareceNomeDeArquivo = (t) => MARCAS_DE_ARQUIVO.test(String(t || ''));

// "Futurama - S11E10 - Final Ending" / "1E01 - Coelhobô" → título que o arquivo traz (se trouxer)
function tituloDoArquivo(caminho) {
    let nome = path.basename(String(caminho || ''), path.extname(String(caminho || '')));
    const m = nome.match(/(?:S\d{1,2}\s*E\d{1,3}(?:-?E?\d{1,3})*|T\d{1,2}\s*E\d{1,3}|\b\d{1,2}x\s*\(?\d{1,3}\)?|\b\d{1,2}E\d{2,3})\s*[-–.:]*\s*(.*)$/i);
    if (!m) return '';
    nome = m[1].replace(/\./g, ' ')
        .replace(/\b(480p|720p|1080p|2160p|WEB-?DL|WEBRip|BluRay|HDTV|SDTV|DVDRip|DVD|Bluray|x264|x265|HEVC|Unknown|Dublado|Dual|FULL HD)\b.*$/i, '')
        .replace(/\s*\[.*$/, '').replace(/\s*\((?!\d{1,2}\)).*$/, '').replace(/\s+/g, ' ').trim();
    return nome.length >= 3 ? nome : '';
}

// Temporada/episódio pelo nome do arquivo: S01E27, T4E01, 1x (10), 1E01, T01E01
function numeroDoArquivo(caminho) {
    const nome = path.basename(String(caminho || ''));
    const padroes = [/S(\d{1,2})\s*E(\d{1,3})/i, /\bT(\d{1,2})\s*E(\d{1,3})/i, /\b(\d{1,2})x\s*\(?(\d{1,3})\)?/i, /\b(\d{1,2})E(\d{2,3})\b/i];
    for (const p of padroes) {
        const m = nome.match(p);
        if (m) return { temporada: Number(m[1]), episodio: Number(m[2]) };
    }
    return null;
}

function pareceIngles(texto) {
    const t = ` ${normalizar(texto)} `;
    const en = (t.match(/ (the|and|of|to|is|his|her|with|when|after|their|from|they|while|who|into) /g) || []).length;
    const pt = (t.match(/ (o|os|as|de|do|da|dos|das|que|um|uma|com|para|nao|seu|sua|em|no|na|ele|ela) /g) || []).length;
    return en >= 3 && en > pt;
}

// ---------- IDENTIFICAÇÃO DE FILME / SÉRIE ----------
// "Up (2009)" / "Up (2009) Bluray-1080p.mkv" → { titulo: 'Up', ano: 2009 }
function tituloAnoDaPasta(item) {
    const caminho = semBarraFinal(item.Path);
    const pasta = item.Type === 'Movie' ? path.basename(path.dirname(caminho)) : path.basename(caminho);
    const m = pasta.match(/^(.*?)\s*\((\d{4})\)/);
    const titulo = (m ? m[1] : pasta).replace(/\s*\[[^\]]*\]/g, '').replace(/\s+-\s+/g, ': ').trim();
    return { titulo, ano: m ? Number(m[2]) : null };
}

// Pastas de extras (padrão do Jellyfin/Plex): arquivo solto nelas não é um filme a identificar
const PASTA_DE_EXTRAS = /^(featurettes?|extras?|behind the scenes|deleted scenes|interviews?|scenes|shorts?|trailers?|other|specials?|bonus|samples?)$/i;

// Só aceita resultado com o ano da pasta (±1) ou, sem ano, com o título idêntico — evita casar "Featurettes"
// com um filme qualquer chamado assim
async function buscarTmdbPorTitulo(tipoTmdb, titulo, ano) {
    if (!titulo) return null;
    const params = { query: titulo };
    if (ano) params[tipoTmdb === 'movie' ? 'year' : 'first_air_date_year'] = ano;
    const r = await tmdbJson(`/search/${tipoTmdb}`, params);
    const confere = (x) => {
        const anoX = Number((x.release_date || x.first_air_date || '').slice(0, 4)) || null;
        if (ano) return anoX && Math.abs(anoX - ano) <= 1;
        return [x.title, x.name, x.original_title, x.original_name].some(t => t && normalizar(t) === normalizar(titulo));
    };
    return (r.results || []).find(confere)?.id || null;
}

// Descobre o TMDB certo do filme/série e diz se o Jellyfin precisa reidentificar o item
async function resolverTmdb(item, tipoTmdb) {
    const atual = item.ProviderIds?.Tmdb ? String(item.ProviderIds.Tmdb) : null;
    if (item.Type === 'Movie' && PASTA_DE_EXTRAS.test(path.basename(path.dirname(semBarraFinal(item.Path))))) return null;
    const arr = await idsDoArr(item);
    if (arr?.Tmdb) return { tmdb: String(arr.Tmdb), extras: arr, reidentificar: atual !== String(arr.Tmdb), origem: 'Radarr/Sonarr' };

    const { titulo, ano } = tituloAnoDaPasta(item);
    if (atual) {
        // ID do Jellyfin com ano bem diferente do da pasta = identificação errada (ex.: Parasite 2019)
        const anoItem = item.ProductionYear || null;
        if (!ano || !anoItem || Math.abs(ano - anoItem) <= 1) return { tmdb: atual, extras: {}, reidentificar: false, origem: 'Jellyfin' };
    }
    if (!atual && item.ProviderIds?.Imdb) {
        const achado = await tmdbJson(`/find/${item.ProviderIds.Imdb}`, { external_source: 'imdb_id' });
        const r = (tipoTmdb === 'movie' ? achado.movie_results : achado.tv_results)?.[0];
        if (r) return { tmdb: String(r.id), extras: {}, reidentificar: true, origem: 'IMDb' };
    }
    const encontrado = await buscarTmdbPorTitulo(tipoTmdb, titulo, ano);
    return encontrado ? { tmdb: String(encontrado), extras: {}, reidentificar: atual !== String(encontrado), origem: `busca "${titulo}" ${ano || ''}`.trim() } : null;
}

// Manda o Jellyfin identificar com o TMDB certo (ele baixa tudo no idioma da biblioteca, pt-br) e espera terminar
async function reidentificarNoJellyfin(item, tmdb, extras) {
    if (simulacao) return item;
    const providerIds = { Tmdb: tmdb };
    if (extras.Imdb) providerIds.Imdb = extras.Imdb;
    if (extras.Tvdb) providerIds.Tvdb = String(extras.Tvdb);
    await jellyfinJson(`/Items/RemoteSearch/Apply/${item.Id}?replaceAllImages=true`, {
        method: 'POST',
        body: JSON.stringify({ Name: item.Name, ProviderIds: providerIds, SearchProviderName: 'TheMovieDb' })
    });
    const limite = Date.now() + ESPERA_IDENTIFICACAO_MS;
    while (Date.now() < limite) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const atual = await jellyfinItemCompleto(item.Id);
        if (String(atual.ProviderIds?.Tmdb || '') === tmdb && atual.Overview && atual.ImageTags?.Primary) return atual;
    }
    console.log(`⚠️ [Metadados] Jellyfin não terminou de identificar "${item.Name}" em ${ESPERA_IDENTIFICACAO_MS / 1000}s — completando o que der.`);
    return jellyfinItemCompleto(item.Id);
}

const travar = (novo, campo) => { novo.LockedFields = [...new Set([...(novo.LockedFields || []), campo])]; };

// ---------- FILME / SÉRIE ----------
// Completa os campos vazios (ou em inglês). Devolve { mudou, traducao } — traducao = o que o TMDB só tem em inglês.
async function completarFilmeOuSerie(itemJf, tipoTmdb, tmdbId) {
    const caminhoTmdb = `/${tipoTmdb}/${tmdbId}`;
    const append = tipoTmdb === 'movie' ? 'release_dates,images' : 'content_ratings,images';
    const [pt, en] = await Promise.all([
        tmdbJson(caminhoTmdb, { append_to_response: append, include_image_language: 'pt,null,en' }),
        tmdbJson(caminhoTmdb, { language: 'en-US' })
    ]);
    const novo = { ...itemJf };
    const travados = new Set(itemJf.LockedFields || []);
    const mudou = [];
    let traducao = null;

    const tituloPt = (pt.title || pt.name || '').trim();
    if (tituloPt && tituloPt !== itemJf.Name && !travados.has('Name')) {
        novo.Name = tituloPt;
        travar(novo, 'Name');  // senão a próxima atualização da biblioteca pode voltar o nome da pasta
        mudou.push(`título "${tituloPt}"`);
    }
    const original = pt.original_title || pt.original_name;
    if (original && !itemJf.OriginalTitle) { novo.OriginalTitle = original; mudou.push('título original'); }

    const sinopsePt = (pt.overview || '').trim();
    const sinopseEn = (en.overview || '').trim();
    const sinopseAtual = (itemJf.Overview || '').trim();
    if (!travados.has('Overview') && (!sinopseAtual || sinopseAtual === sinopseEn || pareceIngles(sinopseAtual))) {
        if (sinopsePt && sinopsePt !== sinopseAtual) {
            novo.Overview = sinopsePt;
            mudou.push('sinopse PT-BR (TMDB)');
        } else if (!sinopsePt && (sinopseEn || sinopseAtual)) {
            traducao = { id: itemJf.Id, sinopse_en: sinopseEn || sinopseAtual };
        }
    }

    if (pt.tagline && !(itemJf.Taglines || []).length) { novo.Taglines = [pt.tagline]; mudou.push('slogan'); }
    if (pt.genres?.length && !(itemJf.Genres || []).length) {
        novo.Genres = pt.genres.map(g => g.name);
        novo.GenreItems = novo.Genres.map(Name => ({ Name }));
        mudou.push('gêneros');
    }
    const cert = classificacaoBrasil(pt, tipoTmdb);
    if (cert && !itemJf.OfficialRating) { novo.OfficialRating = cert; mudou.push('classificação'); }
    const estudios = (pt.production_companies || pt.networks || []).slice(0, 5).map(c => ({ Name: c.name }));
    if (estudios.length && !(itemJf.Studios || []).length) { novo.Studios = estudios; mudou.push('estúdios'); }
    const data = pt.release_date || pt.first_air_date;
    if (data && !itemJf.PremiereDate) { novo.PremiereDate = `${data}T00:00:00.0000000Z`; mudou.push('estreia'); }
    if (data && !itemJf.ProductionYear) novo.ProductionYear = Number(data.slice(0, 4));
    if (pt.vote_average && !itemJf.CommunityRating) { novo.CommunityRating = Math.round(pt.vote_average * 10) / 10; mudou.push('nota'); }
    if (!itemJf.ProviderIds?.Tmdb) novo.ProviderIds = { ...(itemJf.ProviderIds || {}), Tmdb: String(pt.id) };
    if (pt.imdb_id && !itemJf.ProviderIds?.Imdb) novo.ProviderIds = { ...(novo.ProviderIds || {}), Imdb: pt.imdb_id };

    if (mudou.length) await gravarItem(novo);

    const imagens = pt.images || {};
    if (!itemJf.ImageTags?.Primary && await baixarImagemNoJellyfin(itemJf.Id, 'Primary', melhorImagemTmdb(imagens.posters))) mudou.push('capa');
    if (!(itemJf.BackdropImageTags || []).length && await baixarImagemNoJellyfin(itemJf.Id, 'Backdrop', melhorImagemTmdb(imagens.backdrops, true))) mudou.push('fundo');
    if (traducao) traducao.contexto = `${tipoTmdb === 'movie' ? 'Filme' : 'Série'} "${novo.Name}"${novo.ProductionYear ? ` (${novo.ProductionYear})` : ''}`;
    return { mudou, traducao };
}

async function prepararFilmeOuSerie(itemId, tipoTmdb) {
    let itemJf = await jellyfinItemCompleto(itemId);
    const alvo = await resolverTmdb(itemJf, tipoTmdb);
    if (!alvo) {
        console.log(`⚠️ [Metadados] TMDB não encontrado para "${itemJf.Name}" (${itemJf.Path || ''})`);
        return { mudou: [], traducao: null };
    }
    const mudou = [];
    if (alvo.reidentificar) {
        console.log(`🔎 [Metadados] "${itemJf.Name}": identificando como TMDB ${alvo.tmdb} (${alvo.origem})${simulacao ? ' (simulação)' : ''}...`);
        itemJf = await reidentificarNoJellyfin(itemJf, alvo.tmdb, alvo.extras);
        mudou.push(`identificado (TMDB ${alvo.tmdb}, ${alvo.origem})`);
    }
    const r = await completarFilmeOuSerie(itemJf, tipoTmdb, alvo.tmdb);
    return { mudou: [...mudou, ...r.mudou], traducao: r.traducao, tmdb: alvo.tmdb };
}

// ---------- EPISÓDIO ----------
async function temporadaTmdb(tmdbSerie, temporada) {
    try {
        const [pt, en] = await Promise.all([
            tmdbJson(`/tv/${tmdbSerie}/season/${temporada}`),
            tmdbJson(`/tv/${tmdbSerie}/season/${temporada}`, { language: 'en-US' })
        ]);
        return { pt: pt.episodes || [], en: en.episodes || [] };
    } catch (err) {
        return { pt: [], en: [] };
    }
}

// Todos os episódios da série no TMDB (só quando é preciso achar um episódio pelo título)
async function episodiosDaSerie(tmdbSerie) {
    const serie = await tmdbJson(`/tv/${tmdbSerie}`);
    const lista = [];
    for (const { season_number: temporada } of serie.seasons || []) {
        const { pt, en } = await temporadaTmdb(tmdbSerie, temporada);
        for (const e of pt) lista.push({ temporada, numero: e.episode_number, pt: e, en: en.find(x => x.episode_number === e.episode_number) || {} });
    }
    return lista;
}

// Episódio do TMDB cujo título (pt ou en) bate com a pista; só aceita se for um só (título exato tem prioridade)
function acharPorTitulo(lista, pista) {
    const exatos = lista.filter(x => [x.pt.name, x.en.name].some(t => normalizar(t) === normalizar(pista)));
    if (exatos.length === 1) return exatos[0];
    const parecidos = lista.filter(x => [x.pt.name, x.en.name].some(t => !ehTituloGenerico(t) && parecido(pista, t)));
    return parecidos.length === 1 ? parecidos[0] : null;
}

// Devolve { mudou, traducao, pulado } — pulado = motivo para não mexer (numeração duvidosa etc.)
async function completarEpisodio(epJf, serieJf) {
    const tmdbSerie = serieJf?.ProviderIds?.Tmdb;
    if (!tmdbSerie) return { mudou: [], traducao: null, pulado: 'série sem TMDB' };
    const doArquivo = numeroDoArquivo(epJf.Path);
    let temporada = epJf.ParentIndexNumber ?? doArquivo?.temporada;
    let numero = epJf.IndexNumber ?? doArquivo?.episodio;

    const nomeAtual = (epJf.Name || '').trim();
    const nomeRuimBase = ehTituloGenerico(nomeAtual) || pareceNomeDeArquivo(nomeAtual)
        || normalizar(nomeAtual) === normalizar(serieJf.Name) || normalizar(nomeAtual) === normalizar(epJf.SeriesName);
    // título real no Jellyfin ou no nome do arquivo: serve para conferir se o arquivo é mesmo esse episódio do TMDB
    // (ordem de produção, numeração própria, DVD × exibição...)
    const pista = !nomeRuimBase ? nomeAtual : tituloDoArquivo(epJf.Path);

    let alvo = null;
    let motivo = '';
    if (temporada != null && numero != null) {
        const { pt: eps, en: epsEn } = await temporadaTmdb(tmdbSerie, temporada);
        const pt = eps.find(e => e.episode_number === numero);
        const en = epsEn.find(e => e.episode_number === numero) || {};
        if (!pt) motivo = `T${temporada}E${numero} não existe no TMDB`;
        else if (pista && [pt.name, en.name].some(t => !ehTituloGenerico(t)) && !parecido(pista, pt.name) && !parecido(pista, en.name)) {
            motivo = `numeração duvidosa ("${pista}" ≠ TMDB "${pt.name || en.name}")`;
        } else alvo = { pt, en };
    } else {
        motivo = 'sem número de temporada/episódio';
    }
    let achadoPeloTitulo = '';
    if (!alvo && pista) {
        const achado = acharPorTitulo(await episodiosDaSerie(tmdbSerie), pista);
        if (achado) {
            alvo = achado;
            achadoPeloTitulo = `achado pelo título "${pista}" = TMDB T${achado.temporada}E${achado.numero}`;
            if (temporada == null || numero == null) { temporada = achado.temporada; numero = achado.numero; }
        }
    }
    if (!alvo) return { mudou: [], traducao: null, pulado: motivo };
    const { pt, en } = alvo;
    const nomeRuim = nomeRuimBase || nomeAtual === (en.name || '').trim();
    const tituloPt = ehTituloGenerico(pt.name) ? '' : (pt.name || '').trim();
    const tituloEn = ehTituloGenerico(en.name) ? '' : (en.name || '').trim();

    const novo = { ...epJf };
    const travados = new Set(epJf.LockedFields || []);
    const mudou = achadoPeloTitulo ? [achadoPeloTitulo] : [];
    const traducao = { id: epJf.Id };

    if (!travados.has('Name') && nomeRuim) {
        if (tituloPt && tituloPt !== nomeAtual) {
            novo.Name = tituloPt;
            travar(novo, 'Name');
            mudou.push(`título "${tituloPt}"`);
        } else if (!tituloPt && tituloEn) {
            traducao.titulo_en = tituloEn;
        }
    }
    const sinopsePt = (pt.overview || '').trim();
    const sinopseEn = (en.overview || '').trim();
    const sinopseAtual = (epJf.Overview || '').trim();
    if (!travados.has('Overview') && (!sinopseAtual || sinopseAtual === sinopseEn || pareceIngles(sinopseAtual))) {
        if (sinopsePt && sinopsePt !== sinopseAtual) {
            novo.Overview = sinopsePt;
            mudou.push('sinopse PT-BR (TMDB)');
        } else if (!sinopsePt && (sinopseEn || sinopseAtual)) {
            traducao.sinopse_en = sinopseEn || sinopseAtual;
        }
    }
    if (epJf.ParentIndexNumber == null) { novo.ParentIndexNumber = temporada; mudou.push('nº temporada'); }
    if (epJf.IndexNumber == null) { novo.IndexNumber = numero; mudou.push('nº episódio'); }
    if (pt.air_date && !epJf.PremiereDate) { novo.PremiereDate = `${pt.air_date}T00:00:00.0000000Z`; novo.ProductionYear = Number(pt.air_date.slice(0, 4)); mudou.push('estreia'); }
    if (pt.vote_average && !epJf.CommunityRating) { novo.CommunityRating = Math.round(pt.vote_average * 10) / 10; mudou.push('nota'); }

    if (mudou.length > (achadoPeloTitulo ? 1 : 0)) await gravarItem(novo);
    if (!epJf.ImageTags?.Primary && await baixarImagemNoJellyfin(epJf.Id, 'Primary', IMG(pt.still_path))) mudou.push('imagem');
    if (mudou.length === 1 && achadoPeloTitulo) mudou.length = 0;   // achou, mas não havia nada a completar

    const temTraducao = traducao.titulo_en || traducao.sinopse_en;
    if (temTraducao) traducao.contexto = `Série "${serieJf.Name}", T${temporada}E${numero}`;
    return { mudou, traducao: temTraducao ? traducao : null };
}

// ---------- CLAUDE FORA DO AR → GOOGLE TRADUTOR ----------
// 13/10/2026 (pedido do usuário: funcionar se a assinatura do Claude Code acabar). Mesmo arquivo de pausa dos
// scripts Python (buscar_dublado.claude_disponivel): depois de uma falha, ninguém chama o Claude por 30 min.
const CLAUDE_FORA_FILE = path.join(os.homedir(), '.cache', 'jellyfin-bridge', 'claude-fora.json');
const CLAUDE_PAUSA_S = 30 * 60;

function claudeForaInfo() {
    try { return JSON.parse(fs.readFileSync(CLAUDE_FORA_FILE, 'utf8')); } catch { return {}; }
}
function claudeDisponivel() { return Date.now() / 1000 >= (claudeForaInfo().ate || 0); }
function marcarClaudeFora(motivo) {
    const info = claudeForaInfo();
    info.desde = info.desde || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);  // hora local, como no Python
    info.ate = Date.now() / 1000 + CLAUDE_PAUSA_S;
    info.motivo = String(motivo).slice(0, 300);
    const tmp = `${CLAUDE_FORA_FILE}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(info)); fs.renameSync(tmp, CLAUDE_FORA_FILE); } catch { /* sem pausa */ }
}
function marcarClaudeOk() { try { fs.unlinkSync(CLAUDE_FORA_FILE); } catch { /* já não existe */ } }

// Google Tradutor sem chave (endpoint 'gtx', o mesmo do Bazarr): vários textos por pedido, um por linha; se voltar
// outro número de linhas, aquele pedaço vai texto por texto. Quebra de linha dentro do texto viaja como ' / '.
async function googlePedido(linhas) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t';
    for (let tentativa = 0; ; tentativa++) {
        try {
            const resp = await fetch(url, { method: 'POST', body: new URLSearchParams({ q: linhas.join('\n') }),
                headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const d = await resp.json();
            return d[0].map(x => x && x[0] || '').join('').split('\n');
        } catch (err) {
            if (tentativa >= 3) throw err;
            await new Promise(r => setTimeout(r, 2000 * (tentativa + 1)));
        }
    }
}
async function googleTraduzir(textos) {
    const saida = [];
    let pedaco = [], tam = 0;
    const enviar = async () => {
        if (!pedaco.length) return;
        let r = await googlePedido(pedaco);
        if (r.length !== pedaco.length) r = await Promise.all(pedaco.map(async t => (await googlePedido([t])).join(' ')));
        saida.push(...r.map(x => x.replace(/\s*\/\s*/g, ' / ').trim().replace(/ \/ /g, '\n')));
        pedaco = []; tam = 0;
    };
    for (const t of textos) {
        const linha = t.replace(/\s*\n+\s*/g, ' / ');
        if (pedaco.length && tam + linha.length + 1 > 4000) await enviar();
        pedaco.push(linha); tam += linha.length + 1;
    }
    await enviar();
    return saida;
}
// Reserva sem IA: mesmo formato de traduzirLote (Map id → { titulo?, sinopse?, motor: 'Google' })
async function traduzirLoteGoogle(itens) {
    const saida = new Map();
    try {
        const textos = [], destino = [];
        for (const i of itens) {
            if (i.titulo_en) { textos.push(i.titulo_en); destino.push([i.id, 'titulo']); }
            if (i.sinopse_en) { textos.push(i.sinopse_en); destino.push([i.id, 'sinopse']); }
        }
        const trad = await googleTraduzir(textos);
        destino.forEach(([id, campo], k) => {
            if (!trad[k]) return;
            const r = saida.get(String(id)) || { id: String(id), motor: 'Google' };
            r[campo] = trad[k];
            saida.set(String(id), r);
        });
    } catch (err) {
        console.log(`⚠️ [Metadados] Google Tradutor também falhou: ${err.message}`);
    }
    return saida;
}

// ---------- RESERVA: GROQ (18/10/2026) ----------
// Claude fora → Groq (gpt-oss-120b, mesma conta do sistema-mobile-3004.js) → Google Tradutor. A pausa da Groq depois
// de um limite (429) é compartilhada com os scripts Python.
const GROQ_FORA_FILE = path.join(os.homedir(), '.cache', 'jellyfin-bridge', 'groq-fora.json');
function groqChave() {
    if (process.env.GROQ_API_KEY) return String(process.env.GROQ_API_KEY).trim();
    try {
        const m = fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8').match(/^GROQ_API_KEY=(.*)$/m);
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    } catch { return ''; }
}
function groqDisponivel() {
    try { return !!groqChave() && Date.now() / 1000 >= (JSON.parse(fs.readFileSync(GROQ_FORA_FILE, 'utf8')).ate || 0); }
    catch { return !!groqChave(); }
}
async function traduzirLoteGroq(prompt, schema, itens) {
    if (!groqDisponivel()) return null;
    for (const modelo of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
        try {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${groqChave()}`, 'Content-Type': 'application/json', 'User-Agent': 'metadados-ptbr/1.0' },
                body: JSON.stringify({
                    model: modelo, temperature: 0.2, max_completion_tokens: 8192,
                    messages: [{ role: 'system', content: 'Você traduz títulos e sinopses de filmes e séries para português do Brasil e responde apenas no formato JSON pedido.' },
                        { role: 'user', content: prompt }],
                    response_format: { type: 'json_schema', json_schema: { name: 'resposta', schema, strict: false } }
                }),
                signal: AbortSignal.timeout(300000)
            });
            if (r.status === 429) {
                const txt = await r.text();
                if (!/too large/i.test(txt)) fs.writeFileSync(GROQ_FORA_FILE, JSON.stringify({ ate: Date.now() / 1000 + 600, motivo: txt.slice(0, 200) }));
                continue;
            }
            if (!r.ok) { console.log(`⚠️ [Metadados] Groq ${modelo}: HTTP ${r.status}`); continue; }
            const d = await r.json();
            const res = JSON.parse(d.choices[0].message.content);
            fs.appendFile(CUSTOS_CLAUDE_FILE, JSON.stringify({
                quando: new Date().toISOString().slice(0, 19), tarefa: 'metadados-ptbr', modelo: `groq:${modelo}`, usd: 0,
                entrada: d.usage?.prompt_tokens, saida: d.usage?.completion_tokens, itens: itens.length
            }) + '\n', () => {});
            const saida = new Map();
            for (const x of res.itens || []) saida.set(String(x.id), { ...x, motor: 'Groq' });
            console.log(`🤖 [Metadados] traduzido pela Groq (${modelo}): ${saida.size} itens`);
            return saida;
        } catch (e) {
            console.log(`⚠️ [Metadados] Groq ${modelo} falhou: ${String(e.message || e).slice(0, 200)}`);
        }
    }
    return null;
}
// ---------- RESERVA: GEMINI (04/11/2026) ----------
const GEMINI_FORA_FILE = path.join(os.homedir(), '.cache', 'jellyfin-bridge', 'gemini-fora.json');
function geminiChave() { return (process.env.GEMINI_API_KEY || '').trim(); }
function geminiDisponivel() {
    try { return !!geminiChave() && Date.now() / 1000 >= (JSON.parse(fs.readFileSync(GEMINI_FORA_FILE, 'utf8')).ate || 0); }
    catch { return !!geminiChave(); }
}
async function traduzirLoteGemini(prompt, schema, itens) {
    if (!geminiDisponivel()) return null;
    const modelo = 'gemini-3.5-flash';
    try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${geminiChave()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: 'Você traduz títulos e sinopses de filmes e séries para português do Brasil e responde apenas no formato JSON pedido.\n\n' + prompt }] }],
                generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 8192 }
            }),
            signal: AbortSignal.timeout(300000)
        });
        if (r.status === 429) {
            fs.writeFileSync(GEMINI_FORA_FILE, JSON.stringify({ ate: Date.now() / 1000 + 600, motivo: 'HTTP 429' }));
            return null;
        }
        if (!r.ok) { console.log(`⚠️ [Metadados] Gemini ${modelo}: HTTP ${r.status}`); return null; }
        const d = await r.json();
        const res = JSON.parse(d.candidates[0].content.parts[0].text);
        fs.appendFile(CUSTOS_CLAUDE_FILE, JSON.stringify({
            quando: new Date().toISOString().slice(0, 19), tarefa: 'metadados-ptbr', modelo: `gemini:${modelo}`, usd: 0,
            itens: itens.length
        }) + '\n', () => {});
        const saida = new Map();
        for (const x of res.itens || []) saida.set(String(x.id), { ...x, motor: 'Gemini' });
        console.log(`🤖 [Metadados] traduzido pelo Gemini (${modelo}): ${saida.size} itens`);
        return saida;
    } catch (e) {
        console.log(`⚠️ [Metadados] Gemini ${modelo} falhou: ${String(e.message || e).slice(0, 200)}`);
        return null;
    }
}
async function traduzirSemClaude(prompt, schema, itens) {
    const g = await traduzirLoteGroq(prompt, schema, itens);
    if (g && g.size) return g;
    const ge = await traduzirLoteGemini(prompt, schema, itens);
    return ge && ge.size ? ge : traduzirLoteGoogle(itens);
}

// ---------- TRADUÇÃO PELO CLAUDE ----------
// itens: [{ id, contexto, titulo_en?, sinopse_en? }] → Map id → { titulo?, sinopse?, motor? }
// Claude fora do ar (ou falhou agora) → Google Tradutor (traduzirLoteGoogle).
function traduzirLote(itens, assunto = 'mídia') {
    if (!itens.length) return Promise.resolve(new Map());
    const schema = {
        type: 'object',
        properties: { itens: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, titulo: { type: 'string' }, sinopse: { type: 'string' } }, required: ['id'] } } },
        required: ['itens']
    };
    const lista = itens.map(i => ({ id: i.id, onde: i.contexto, ...(i.titulo_en ? { titulo_en: i.titulo_en } : {}), ...(i.sinopse_en ? { sinopse_en: i.sinopse_en } : {}) }));
    const prompt = `Traduza para português do Brasil (${assunto}). Para cada item devolva o mesmo "id" e:
- "titulo": só se houver "titulo_en" — use o título oficial lançado no Brasil se você souber; senão uma tradução natural e curta (nomes próprios ficam como estão).
- "sinopse": só se houver "sinopse_en" — tradução natural e fiel, sem acrescentar nada; use os nomes oficiais no Brasil de personagens/lugares se souber.

${JSON.stringify(lista, null, 1)}`;
    if (!claudeDisponivel()) return traduzirSemClaude(prompt, schema, itens);
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '',
        '--system-prompt', 'Você traduz títulos e sinopses de filmes e séries para português do Brasil e responde apenas no formato JSON pedido, sem texto extra.',
        '--model', CLAUDE_MODELO, '--json-schema', JSON.stringify(schema), prompt];
    return new Promise((resolve) => {
        execFile(CLAUDE_BIN, args, { timeout: 900000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, MAX_THINKING_TOKENS: '0' } }, (err, stdout, stderr) => {
            if (err) {
                console.log(`⚠️ [Metadados] claude -p falhou ao traduzir: ${err.message.slice(0, 200)} — usando a Groq / Google Tradutor`);
                marcarClaudeFora((stderr || stdout || '').trim() || (err.killed ? 'tempo esgotado' : `código ${err.code}`));
                return resolve(traduzirSemClaude(prompt, schema, itens));
            }
            try {
                const d = JSON.parse(stdout);
                if (d.is_error) {
                    console.log(`⚠️ [Metadados] claude -p deu erro: ${String(d.result).slice(0, 200)} — usando a Groq / Google Tradutor`);
                    marcarClaudeFora(d.result);
                    return resolve(traduzirSemClaude(prompt, schema, itens));
                }
                marcarClaudeOk();
                const u = d.usage || {};
                fs.appendFile(CUSTOS_CLAUDE_FILE, JSON.stringify({
                    quando: new Date().toISOString().slice(0, 19), tarefa: 'metadados-ptbr', modelo: CLAUDE_MODELO,
                    usd: d.total_cost_usd, ms: d.duration_ms, entrada: u.input_tokens, saida: u.output_tokens, itens: itens.length
                }) + '\n', () => {});
                const saida = new Map();
                for (const r of (d.is_error ? [] : d.structured_output?.itens || [])) saida.set(String(r.id), r);
                resolve(saida);
            } catch (e) {
                console.log(`⚠️ [Metadados] Resposta inválida do claude: ${e.message}`);
                resolve(new Map());
            }
        });
    });
}

// Grava as traduções (título e/ou sinopse) e trava os campos para a atualização da biblioteca não voltar o inglês
async function aplicarTraducoes(pendentes, traduzidos) {
    const feitos = [];
    for (const p of pendentes) {
        const t = traduzidos.get(String(p.id));
        if (!t) continue;
        const item = await jellyfinItemCompleto(p.id);
        const novo = { ...item };
        const mudou = [];
        const motor = t.motor || 'Claude';
        if (p.titulo_en && t.titulo?.trim()) { novo.Name = t.titulo.trim(); travar(novo, 'Name'); mudou.push(`título "${novo.Name}" (${motor})`); }
        if (p.sinopse_en && t.sinopse?.trim()) { novo.Overview = t.sinopse.trim(); travar(novo, 'Overview'); mudou.push(`sinopse (${motor})`); }
        if (mudou.length) {
            await gravarItem(novo);
            feitos.push({ id: p.id, nome: novo.Name, mudou });
        }
    }
    return feitos;
}

// ---------- ENTRADA DO BRIDGE (um item novo) ----------
// Devolve o item atualizado (mesclado com o do webhook) para a mensagem já sair com os dados novos
async function completarMetadadosPtBr(item, itemId) {
    if (!JELLYFIN_API_KEY || !TMDB_API_KEY || !itemId || !['Movie', 'Series', 'Episode'].includes(item.Type)) return item;
    try {
        const pendentes = [];
        const registrar = (rotulo, r) => {
            if (r.mudou?.length) console.log(`📝 [Metadados] ${rotulo}: ${r.mudou.join(', ')}`);
            if (r.pulado) console.log(`⏩ [Metadados] ${rotulo}: ${r.pulado}`);
            if (r.traducao) pendentes.push(r.traducao);
        };
        if (item.Type === 'Movie' || item.Type === 'Series') {
            registrar(`"${item.Name}"`, await prepararFilmeOuSerie(itemId, item.Type === 'Movie' ? 'movie' : 'tv'));
        } else {
            const ep = await jellyfinItemCompleto(itemId);
            if (ep.SeriesId) registrar(`Série "${ep.SeriesName}"`, await prepararFilmeOuSerie(ep.SeriesId, 'tv'));
            const serie = ep.SeriesId ? await jellyfinItemCompleto(ep.SeriesId) : null;
            const epAtual = await jellyfinItemCompleto(itemId); // a reidentificação da série pode ter mudado o episódio
            registrar(`Episódio "${epAtual.Name}"`, await completarEpisodio(epAtual, serie));
        }
        if (pendentes.length) {
            for (const f of await aplicarTraducoes(pendentes, await traduzirLote(pendentes))) {
                console.log(`📝 [Metadados] "${f.nome}": ${f.mudou.join(', ')}`);
            }
        }
        const atualizado = await jellyfinItemCompleto(itemId);
        return { ...item, ...atualizado, Year: atualizado.ProductionYear || item.Year };
    } catch (err) {
        console.error(`❌ [Metadados] Erro ao completar "${item.Name}": ${err.message}`);
        return item;
    }
}

module.exports = {
    completarMetadadosPtBr, prepararFilmeOuSerie, completarEpisodio, traduzirLote, aplicarTraducoes,
    jellyfinJson, jellyfinItemCompleto, setSimulacao,
    ehTituloGenerico, pareceNomeDeArquivo, pareceIngles, numeroDoArquivo, tituloDoArquivo,
};
