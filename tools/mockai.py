#!/usr/bin/env python3
"""
mockai.py — a stand-in for the three local AI endpoints in docs/LOCAL_AI_SETUP.md.

Pure Python stdlib. Lets you exercise the whole NPC dialogue pipeline
(mic -> STT -> chat -> tool calls -> game state -> TTS -> playback) without
running Whisper, an LLM or paying fish.audio. Also the harness the dialogue
system is tested against.

    python3 tools/mockai.py --port 8188

Then in-game press O and set:
    sttUrl   http://127.0.0.1:8188/stt
    chatUrl  http://127.0.0.1:8188/v1/chat/completions
    fishUrl  http://127.0.0.1:8188/v1/tts
    fishKey  anything-nonempty

Routes
    POST /stt                    multipart field `audio` -> {"text": ...}
                                 ?text=... overrides the transcript
    POST /v1/chat/completions    OpenAI-compatible, emits tool_calls for money talk
                                 ?tools=off simulates a model with no tool-call
                                 support (the realistic weak-model failure mode)
                                 ?fail=500 / ?fail=slow / ?fail=garbage for error paths
    POST /v1/tts                 -> a short valid WAV (any audio endpoint works)
    GET  /health                 -> {"ok": true}
    GET  /log                    -> recent requests, for assertions
    POST /control                 {"transcript": "..."} queue the next STT result

Every response carries the CORS headers the contract requires and OPTIONS is
answered with 204, because a silent failure with no server log is almost always
a missing preflight.
"""

import argparse
import io
import json
import math
import re
import struct
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_TRANSCRIPT = "how much money do i have in my account"

STATE = {
    "queue": [],          # queued STT transcripts
    "log": [],            # recent requests
    "lock": threading.Lock(),
}

VEHICLES = [
    {"id": "coupe",   "name": "Vice Coupe",    "price": 24000},
    {"id": "cruiser", "name": "Coast Cruiser", "price": 12500},
    {"id": "moped",   "name": "Sunset Moped",  "price": 1800},
]


# ----------------------------------------------------------------- audio ----
def wav_bytes(seconds=0.35, freq=196.0, rate=8000):
    """A tiny, genuinely decodable WAV. Real TTS would return mp3; the contract
    says any endpoint returning audio works, and a WAV needs no encoder."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(rate * seconds)
        frames = bytearray()
        for i in range(n):
            # fade in/out so it does not click
            env = min(1.0, i / (rate * 0.05), (n - i) / (rate * 0.05))
            v = int(9000 * env * math.sin(2 * math.pi * freq * i / rate))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return buf.getvalue()


# ------------------------------------------------------------- multipart ----
def parse_multipart(body, content_type):
    """Minimal multipart/form-data reader: enough to find the `audio` field."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return {}
    boundary = ("--" + m.group(1)).encode()
    out = {}
    for part in body.split(boundary):
        if not part or part in (b"--\r\n", b"--"):
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        if not _:
            continue
        headers = head.decode("utf-8", "replace")
        name = re.search(r'name="([^"]*)"', headers)
        fn = re.search(r'filename="([^"]*)"', headers)
        if not name:
            continue
        out[name.group(1)] = {
            "filename": fn.group(1) if fn else None,
            "bytes": len(data.rstrip(b"\r\n-")),
            "ctype": (re.search(r"Content-Type:\s*([^\r\n]+)", headers) or [None, ""])[1],
        }
    return out


# ------------------------------------------------------------------ chat ----
def last_of_role(messages, role):
    for m in reversed(messages):
        if m.get("role") == role:
            return m
    return None


def tool_replies(messages):
    """Collect the tool results that came back after the most recent assistant
    turn that asked for them."""
    out = []
    for m in reversed(messages):
        if m.get("role") == "tool":
            out.append(m)
        elif m.get("role") == "assistant":
            break
    return list(reversed(out))


def money(n):
    try:
        return "${:,}".format(int(round(float(n))))
    except Exception:
        return str(n)


def summarise_tool_results(results):
    """Turn real tool output into a sentence, the way a competent model would.
    Only ever speaks numbers the game actually returned."""
    bits = []
    for r in results:
        try:
            payload = json.loads(r.get("content") or "{}")
        except Exception:
            payload = {"raw": r.get("content")}
        if payload.get("ok") is False:
            bits.append("I'm sorry, that didn't go through: %s" %
                        (payload.get("message") or payload.get("error") or "declined"))
            continue
        if "vehicles" in payload:
            bits.append("On the lot today: " + ", ".join(
                "%s at %s" % (v.get("name"), money(v.get("price"))) for v in payload["vehicles"]))
        elif "directions" in payload or "heading" in payload:
            bits.append(str(payload.get("directions") or payload.get("heading")))
        elif "waypoint" in payload:
            bits.append("Marker dropped. " + str(payload.get("waypoint")))
        elif "deposited" in payload:
            bits.append("Deposited %s. Your balance is now %s." %
                        (money(payload["deposited"]), money(payload.get("balance"))))
        elif "withdrawn" in payload:
            bits.append("Here's %s. Your balance is now %s." %
                        (money(payload["withdrawn"]), money(payload.get("balance"))))
        elif "purchased" in payload:
            bits.append("Congratulations, the %s is yours. %s left." %
                        (payload["purchased"], money(payload.get("balance"))))
        elif "balance" in payload:
            bits.append("Your current balance is %s." % money(payload["balance"]))
        else:
            bits.append(json.dumps(payload))
    return " ".join(bits) if bits else "All done."


def decide_tool(text):
    """Very small intent router — stands in for the model's tool selection."""
    t = (text or "").lower()
    m = re.search(r"deposit\D{0,12}(\d[\d,]*)", t)
    if m:
        return "deposit", {"amount": int(m.group(1).replace(",", ""))}
    m = re.search(r"(?:withdraw|take out|cash out)\D{0,12}(\d[\d,]*)", t)
    if m:
        return "withdraw", {"amount": int(m.group(1).replace(",", ""))}
    if re.search(r"\bbalance\b|how much (money|do i have|is in)|what.*account", t):
        return "get_balance", {}
    if re.search(r"buy .*(coupe|cruiser|moped)", t):
        which = re.search(r"(coupe|cruiser|moped)", t).group(1)
        return "buy_vehicle", {"vehicle_id": which}
    if re.search(r"\b(cars|vehicles|for sale|on the lot|inventory)\b", t):
        return "list_vehicles", {}
    if re.search(r"where(?:'s| is)|how do i get to|directions", t):
        dest = re.sub(r".*?(?:where(?:'s| is)|how do i get to|directions to)\s*", "", t).strip(" ?.")
        return "give_directions", {"destination": dest or "the bank"}
    if re.search(r"mark (it|that)|waypoint|put it on my map", t):
        return "set_waypoint", {"label": "marked spot"}
    return None, None


def chat_response(body, opts):
    messages = body.get("messages") or []
    model = body.get("model") or "mock-model"
    results = tool_replies(messages)

    if results:
        content = summarise_tool_results(results)
        return openai_envelope(model, content=content)

    user = last_of_role(messages, "user")
    text = (user or {}).get("content") or ""
    name, args = decide_tool(text)

    if name and not opts.get("no_tools"):
        return openai_envelope(model, tool_calls=[{
            "id": "call_%d" % (int(time.time() * 1000) % 100000),
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        }])

    if name and opts.get("no_tools"):
        # The realistic weak-tool-call failure: sounds helpful, does nothing.
        return openai_envelope(model, content=(
            "Certainly, I have taken care of that for you right away."))

    return openai_envelope(model, content=(
        "[mock] I heard: \"%s\". Ask me about your balance, a deposit, or the cars for sale."
        % text.strip()[:160]))


def openai_envelope(model, content=None, tool_calls=None):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
        msg["content"] = None
    return {
        "id": "chatcmpl-mock-%d" % int(time.time() * 1000),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": msg,
                     "finish_reason": "tool_calls" if tool_calls else "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


# --------------------------------------------------------------- handler ----
class Handler(BaseHTTPRequestHandler):
    server_version = "mockai/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing
    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        allow = ORIGIN if ORIGIN != "echo" else origin
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def _send(self, code, payload=b"", ctype="application/json"):
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload).encode()
        elif isinstance(payload, str):
            payload = payload.encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def log_message(self, fmt, *a):
        sys.stderr.write("  mockai %s\n" % (fmt % a))

    def _note(self, entry):
        with STATE["lock"]:
            STATE["log"].append(entry)
            del STATE["log"][:-60]

    # -- verbs
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._send(200, {"ok": True, "service": "mockai", "routes":
                                    ["/stt", "/v1/chat/completions", "/v1/tts"]})
        if path == "/log":
            with STATE["lock"]:
                return self._send(200, {"log": list(STATE["log"])})
        return self._send(404, {"error": "not found", "path": path})

    def do_POST(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        body = self._read()

        fail = (q.get("fail") or [""])[0]
        if fail == "500":
            return self._send(500, {"error": "simulated upstream failure"})
        if fail == "garbage":
            return self._send(200, "<html>not json at all</html>", "text/html")
        if fail == "slow":
            time.sleep(45)

        if path == "/control":
            try:
                data = json.loads(body or b"{}")
            except Exception:
                data = {}
            with STATE["lock"]:
                if data.get("transcript"):
                    STATE["queue"].append(data["transcript"])
            return self._send(200, {"ok": True, "queued": len(STATE["queue"])})

        if path == "/stt":
            fields = parse_multipart(body, self.headers.get("Content-Type", ""))
            audio = fields.get("audio")
            override = (q.get("text") or [None])[0]
            with STATE["lock"]:
                queued = STATE["queue"].pop(0) if STATE["queue"] else None
            text = override or queued or DEFAULT_TRANSCRIPT
            self._note({"t": time.time(), "route": "stt", "bytes": len(body),
                        "field_audio": bool(audio), "audio_bytes": (audio or {}).get("bytes"),
                        "returned": text})
            if not audio:
                return self._send(400, {"error": "missing multipart field 'audio'"})
            return self._send(200, {"text": text})

        if path.endswith("/chat/completions"):
            try:
                data = json.loads(body or b"{}")
            except Exception:
                return self._send(400, {"error": "bad json"})
            opts = {"no_tools": (q.get("tools") or [""])[0] == "off"}
            resp = chat_response(data, opts)
            self._note({"t": time.time(), "route": "chat", "model": data.get("model"),
                        "messages": len(data.get("messages") or []),
                        "tools_offered": [t.get("function", {}).get("name")
                                          for t in (data.get("tools") or [])],
                        "temperature": data.get("temperature"),
                        "auth": bool(self.headers.get("Authorization")),
                        "replied_tool_calls": [c["function"]["name"] for c in
                                               (resp["choices"][0]["message"].get("tool_calls") or [])]})
            return self._send(200, resp)

        if path.endswith("/tts"):
            try:
                data = json.loads(body or b"{}")
            except Exception:
                data = {}
            audio = wav_bytes()
            self._note({"t": time.time(), "route": "tts", "chars": len(data.get("text") or ""),
                        "reference_id": data.get("reference_id"),
                        "auth": bool(self.headers.get("Authorization")),
                        "audio_bytes": len(audio)})
            return self._send(200, audio, "audio/wav")

        return self._send(404, {"error": "not found", "path": path})


ORIGIN = "echo"


def main():
    global ORIGIN
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8188)
    ap.add_argument("--origin", default="echo",
                    help="Access-Control-Allow-Origin value, or 'echo' to mirror the caller")
    a = ap.parse_args()
    ORIGIN = a.origin
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print("mockai listening on http://%s:%d" % (a.host, a.port))
    print("  sttUrl   http://%s:%d/stt" % (a.host, a.port))
    print("  chatUrl  http://%s:%d/v1/chat/completions" % (a.host, a.port))
    print("  fishUrl  http://%s:%d/v1/tts" % (a.host, a.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
