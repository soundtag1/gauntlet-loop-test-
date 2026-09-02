# Local AI NPCs — setup contract

Lets you walk up to an NPC, hold a key, talk, and have them answer in voice and
act on the game world. Everything runs on your machine except fish.audio TTS.

Nothing here is required. With no config the game falls back to scripted text
dialogue, so the build always works standalone.

## Pipeline
    mic (browser)  ->  STT endpoint (local Whisper)
                   ->  chat endpoint (local LLM, per-NPC model + system prompt)
                   ->  tool calls (act on the game)
                   ->  fish.audio TTS (per-NPC voice)  ->  audio playback

## Configuration
In-game: press `O` for the AI Settings panel. Values persist in `localStorage`
under `neoncoast.ai`. Nothing is committed to the repo.

| Field        | Example                          | Notes                          |
| ------------ | -------------------------------- | ------------------------------ |
| `sttUrl`     | `http://127.0.0.1:8081/stt`      | local Whisper                  |
| `chatUrl`    | `http://127.0.0.1:8080/v1/chat/completions` | OpenAI-compatible   |
| `apiKey`     | (optional)                       | sent as `Authorization: Bearer` |
| `fishKey`    | (your fish.audio key)            | stored locally only            |
| `fishUrl`    | `https://api.fish.audio/v1/tts`  | override if self-hosting       |

Per NPC you can set model, voice id, temperature and system prompt in the same
panel; defaults ship in `src/systems/dialogue.js`.

## Endpoint 1 — STT
`POST {sttUrl}`, `multipart/form-data`, field `audio` (webm/opus or wav).
```json
{ "text": "how much money do i have" }
```

## Endpoint 2 — Chat
`POST {chatUrl}` — OpenAI-compatible, so llama.cpp, Ollama (`/v1`), vLLM and
LM Studio all work unmodified.
```json
{ "model": "<per-npc>", "messages": [...], "tools": [...], "temperature": 0.8 }
```
Standard response, including `tool_calls`. Streaming is not required.

## Endpoint 3 — TTS
`POST {fishUrl}` with `Authorization: Bearer {fishKey}`.
```json
{ "text": "You have four thousand dollars.", "reference_id": "<voice id>", "format": "mp3" }
```
Returns audio bytes. Any endpoint returning audio works — set `fishUrl` to your own.

## CORS — the one thing that will bite you
The game runs on `http://127.0.0.1:5177`; your servers are a different origin, so
they MUST send CORS headers or the browser blocks the request:
```
Access-Control-Allow-Origin: http://127.0.0.1:5177
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Methods: POST, OPTIONS
```
and answer `OPTIONS` preflight with 204. In FastAPI use `CORSMiddleware`; in
Flask use `flask-cors`. A silent failure with no server log is almost always this.

## Tools the NPCs may call
Deliberately a small allowlist — an NPC can only do these, never arbitrary actions:

| Tool                  | Who        | Effect                          |
| --------------------- | ---------- | ------------------------------- |
| `get_balance`         | teller     | reads player balance            |
| `deposit`             | teller     | moves cash -> bank              |
| `withdraw`            | teller     | moves bank -> cash              |
| `list_vehicles`       | dealer     | vehicles for sale + prices      |
| `buy_vehicle`         | dealer     | purchase if affordable          |
| `give_directions`     | any        | points to a venue or district   |
| `set_waypoint`        | any        | drops a map marker              |

Each returns a JSON result fed back to the model. Spending tools verify funds
game-side and refuse when short — the model is never trusted to decide that.

## Two cautions
1. `fishKey` lives in the browser. Fine locally; if you ever host this publicly,
   proxy TTS through your own server instead so the key is not shipped to clients.
2. NPC replies are model output — treated as dialogue text only, never as
   instructions to the game. Only the allowlisted tools above can change state.
