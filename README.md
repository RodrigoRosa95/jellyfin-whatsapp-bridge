# Jellyfin → WhatsApp (bridge)

Ponte em Node.js que recebe os **webhooks do Jellyfin, Sonarr e Radarr** e manda **avisos no WhatsApp** com capa, sinopse e notas (IMDb/TMDb). Feita para o servidor de mídia caseiro RodrigoFlix.

```
 Jellyfin (plugin Webhook) ─┐
 Sonarr (On Grab) ──────────┼──► bridge.js (:3005) ──► bot de WhatsApp (POST /send, :8082)
 Radarr (lançamentos) ──────┘        │
                                     ├─ TMDb / OMDb / IMDb (notas, capas, títulos)
                                     └─ metadados-ptbr.js (completa título e sinopse em PT-BR no Jellyfin)
```

## Recursos
- **Item novo** (`ItemAdded`): capa, título em PT-BR, sinopse, notas e links (item, IMDb, TMDb). Espera os metadados do Jellyfin ficarem prontos (`ITEM_ADDED_DELAY_MINUTES`, `ITEM_ADDED_MAX_TENTATIVAS`).
- **Início de reprodução** (`PlaybackStart`): um aviso por filme/episódio (`PLAYBACK_TTL_HORAS`); parar nunca avisa. Cooldown de 30 s contra mensagens repetidas.
- **Sonarr:** lembrete de estreia de episódio (`SONARR_REMINDER_MINUTES_BEFORE`) e aviso de *grab* (`POST /sonarr-webhook`). Antes do aviso de download dá para conferir se os arquivos do torrent são vídeo (`BLOQUEAR_FALSOS_PY`, opcional).
- **Radarr:** lançamentos digitais (`POST /radarr-webhook`).
- **Destinatários por usuário:** `user_phone_map.json` liga o usuário do Jellyfin ao telefone (recarregado a cada 5 min), para avisar quem pediu/assiste.
- **Capas com reserva:** Jellyfin → série → OMDb → TMDb → URL padrão → placeholder PNG gerado com `sharp`.
- **Metadados em PT-BR** (`metadados-ptbr.js`): completa título e sinopse que faltam, com TMDb e, como reserva, IA (Groq, Gemini ou CLI do Claude).
- **Echo Dot:** anúncio de estreias via webhook do Home Assistant (`HA_WEBHOOK_URL`, `ECHO_*`).

## Rotas
| Método | Caminho | Quem chama |
|---|---|---|
| POST | `/jellyfin-webhook` | Plugin Webhook do Jellyfin |
| POST | `/reenviar-item-added` | Você, para reenviar o aviso de um item |
| POST | `/sonarr-webhook` | Sonarr → Connect → Webhook (On Grab) |
| POST | `/radarr-webhook` | Radarr → Connect → Webhook |
| GET | `/sonarr-reminders/run` | Roda os lembretes na hora |
| GET | `/sonarr-reminders/status` | Estado dos lembretes |

## Instalação
Requer Node 20+ e um **bot de WhatsApp** com `POST /send` (`{ number, message }`) e, para imagens, `POST /enviar`. O `whatsapp-bot.js` do repositório [sistema-financeiro-open](https://github.com/RodrigoRosa95/sistema-financeiro-open) serve.
```bash
npm install
cp .env.exemplo .env        # preencha
node bridge.js              # porta 3005 (BRIDGE_PORT)
```
No Jellyfin, instale o plugin **Webhook** e aponte um destino genérico para `http://IP-DO-BRIDGE:3005/jellyfin-webhook` com os eventos `ItemAdded` e `PlaybackStart`. Com `JELLYFIN_API_KEY` o bridge busca os dados completos do item.

## Variáveis principais
| Variável | Uso |
|---|---|
| `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `PUBLIC_JELLYFIN_URL` | Servidor (interno e o endereço que vai nos links). |
| `JELLYFIN_SERVER_ID` | Id usado nos links (opcional). |
| `ATSAPP_API_URL` | URL do bot de WhatsApp (padrão `http://localhost:8082`). |
| `WHATSAPP_NUMBERS`, `JELLYFIN_WHATSAPP_GROUP`, `JELLYFIN_TODOS_GROUP` | Quem recebe os avisos. |
| `SONARR_URL`, `SONARR_API_KEY`, `RADARR_URL`, `RADARR_API_KEY` | Integração com Sonarr/Radarr. |
| `TMDB_API_KEY`, `OMDB_API_KEY` | Capas, notas e títulos. |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_BIN` | Reserva de IA para sinopses. |
| `HA_WEBHOOK_URL` | Home Assistant (anúncio na Echo). |
Veja `.env.exemplo` para todas.

## O que não está nesta versão
O módulo `jellyflix-whatsapp.js` (comandos de grupo, enquetes e resumos), que liga o bridge a scripts pessoais do servidor, **não foi incluído**: o bridge o carrega só se existir. A conferência de arquivos de torrent também é opcional.

## Licença
MIT
