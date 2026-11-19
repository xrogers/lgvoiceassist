#!/usr/bin/env python3
"""End-to-end test of what the daemon is for, off-TV: voice audio, events, announcements and translated texts,
between the REAL daemon and the REAL aioesphomeapi client, over the encrypted and the plaintext transport.

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install aioesphomeapi
    /tmp/venv/bin/python tools/test_voice.py              # exit code 0 = all passed

The TV side is faked through tools/daemon_harness.py: a USB microphone (pactl lists one, parec produces a
16-bit counter so every sample can be checked), LG's settings service (luna-send answers with the TV menu
language, exactly as a webOS 5 TV does) and toasts (luna-send calls are recorded).
"""
import asyncio
import base64
import json
import os
import re
import shlex
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from daemon_harness import DaemonHarness, ROOT  # noqa: E402

from aioesphomeapi import APIClient, VoiceAssistantEventType as Ev, VoiceAssistantTimerEventType as Tm  # noqa: E402

NAME = "lgtv-test"
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (("  -- " + str(detail)) if detail and not ok else ""))


# What `luna-send -n 1 luna://com.webos.settingsservice/getSystemSettings '{"keys":["localeInfo"]}'` prints on an
# LG OLED55CX (webOS 5.6.2) with the menu in Polish.
LOCALE_JSON = ('{"subscribed":%s,"method":"getSystemSettings","settings":{"localeInfo":{"locales":{"UI":"%s","TV":"en-GB",'
               '"FMT":"en-GB","NLP":"en-GB","STT":"pl-PL","AUD":"pl-PL","AUD2":"en-GB"},"clock":"locale",'
               '"keyboards":["en","pl"],"timezone":""}},"returnValue":true}')


def luna_send(ui_locale):
    """Records every call; answers the locale subscription (ui_locale=None: the service never answers)."""
    answer = "" if ui_locale is None else "echo '%s'; " % (LOCALE_JSON % ("true", ui_locale))
    return ("#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$LGTV_HARNESS_DIR/tmp/luna.log\"\n"
            "case \"$*\" in *getSystemSettings*) " + answer + "exec sleep 600 ;; *getPowerState*) exec sleep 600 ;; esac\n"
            "exit 0\n")


PACTL = ("#!/bin/sh\n"
         "case \"$*\" in *'list sources short'*) printf '3\\talsa_input.usb-Fake_Mic-00.analog-mono\\tmodule-alsa-card.c\\ts16le 1ch 48000Hz\\tRUNNING\\n' ;; esac\n"
         "exit 0\n")
# BusyBox timeout on the user-tested TV rejects GNU's `-t`; record what the daemon asks for, then succeed at once.
TIMEOUT = ("#!/bin/sh\n"
           "printf '%s\\n' \"$*\" >> \"$LGTV_HARNESS_DIR/tmp/timeout.log\"\n"
           "exit 0\n")
# 16 kHz s16le mono in real time: sample n has the value n mod 65536, so loss, reordering or corruption shows
PAREC = ("#!/bin/sh\n"
         "exec python3 -u -c '\n"
         "import struct, sys, time\n"
         "n = 0; t = time.time()\n"
         "while True:\n"
         "    sys.stdout.buffer.write(struct.pack(\"<320H\", *[(n + i) & 0xffff for i in range(320)])); sys.stdout.buffer.flush()\n"
         "    n += 320; t += 0.02; time.sleep(max(0, t - time.time()))\n"
         "'\n")


def luna_log(d):
    try:
        with open(os.path.join(d.dir, "tmp", "luna.log"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def timeout_log(d):
    try:
        with open(os.path.join(d.dir, "tmp", "timeout.log"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


async def wait_for(pred, timeout=8.0):
    end = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < end:
        if pred():
            return True
        await asyncio.sleep(0.05)
    return bool(pred())


class Voice:
    """The Home Assistant side of a voice session: accepts every run, keeps the audio."""

    def __init__(self, client):
        self.client = client
        self.starts = []
        self.audio = bytearray()
        self.stops = 0
        client.subscribe_voice_assistant(handle_start=self.on_start, handle_stop=self.on_stop, handle_audio=self.on_audio)

    async def on_start(self, conversation_id, flags, audio_settings, wake_word_phrase):
        self.starts.append(flags)
        self.audio = bytearray()
        return 0                      # port 0 = audio over the API connection

    async def on_stop(self, abort):
        self.stops += 1

    async def on_audio(self, data, data2=b""):      # data2: second half when the client splits a ring buffer
        self.audio += data
        self.audio += data2


def continuous(pcm):
    """True if the 16-bit samples count up by one without a gap (see PAREC)."""
    n = len(pcm) // 2
    if n < 2 or len(pcm) % 2:
        return False
    import struct
    v = struct.unpack("<%dH" % n, bytes(pcm[:2 * n]))
    return all(((v[i] + 1) & 0xffff) == v[i + 1] for i in range(n - 1))


async def session_suite(encryption):
    label = "encrypted" if encryption else "plaintext"
    print("\n== voice session, %s; TV menu language Polish ==" % label)
    settings = {"name": NAME, "friendly_name": "LG Test", "wake_word": "ha"}   # Home Assistant detects the wake word
    if encryption:
        settings["api_key"] = base64.b64encode(os.urandom(32)).decode()      # as provisioned by Home Assistant
    else:
        settings["encryption"] = False
    with DaemonHarness(settings=settings, fakes={"luna-send": luna_send("pl-PL"), "pactl": PACTL, "parec": PAREC,
                                                 "timeout": TIMEOUT}) as d:
        client = APIClient("127.0.0.1", d.port, None, noise_psk=d.key if encryption else None, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check(label + ": status file says encryption %s" % encryption, d.status().get("encryption") is encryption)
        ents, _ = await asyncio.wait_for(client.list_entities_services(), 10)
        names = sorted(e.name for e in ents)
        check(label + ": screen switch is named in the TV menu language (Ekran)", "Ekran" in names, names)
        check(label + ": language taken from the settings service", "language: TV menu pl-PL -> pl" in d.log(), d.log()[-400:])

        # hands-free: the daemon streams the USB microphone as soon as Home Assistant subscribes
        voice = Voice(client)
        check(label + ": daemon starts a wake word run", await wait_for(lambda: voice.starts, 25), d.log()[-600:])
        check(label + ": run asks for wake word + VAD (flags 3)", voice.starts[:1] == [3], voice.starts)
        await wait_for(lambda: len(voice.audio) >= 64000, 10)
        got = bytes(voice.audio)
        check(label + ": 2 s of microphone audio arrived (%d bytes)" % len(got), len(got) >= 64000)
        check(label + ": every sample arrived once, in order", continuous(got), got[:16].hex())

        # the pipeline's events drive the toasts on the TV
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_WAKE_WORD_END, None)
        check(label + ": wake word -> Polish 'listening' toast", await wait_for(lambda: "Słucham…" in luna_log(d)), luna_log(d)[-300:])
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_STT_END, {"text": "zażółć gęślą jaźń"})
        check(label + ": recognised text is shown", await wait_for(lambda: "zażółć gęślą jaźń" in luna_log(d)))
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_ERROR, {"code": "stt-no-text-recognized", "message": "x"})
        check(label + ": error -> Polish toast", await wait_for(lambda: "Nie usłyszałem polecenia" in luna_log(d)), luna_log(d)[-300:])
        runs = len(voice.starts)
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_RUN_END, None)
        check(label + ": after the run the daemon listens again", await wait_for(lambda: len(voice.starts) > runs, 10), d.log()[-400:])
        await wait_for(lambda: len(voice.audio) >= 16000, 10)
        check(label + ": audio of the next run is intact too", len(voice.audio) >= 16000 and continuous(bytes(voice.audio)))

        # announcement: Home Assistant -> TV, answered when playback (a fake player here) is over
        fin = await client.send_voice_assistant_announcement_await_response("http://127.0.0.1:9/tts.mp3", 10, "Kolacja gotowa")
        check(label + ": announcement finished with success", fin.success is True, fin)
        check(label + ": announcement text is shown", "Kolacja gotowa" in luna_log(d))
        # playUrls must call BusyBox-compatible `timeout SECONDS` (GNU's `-t` is unavailable on the tested TV)
        check(label + ": MP3 playback uses BusyBox-compatible timeout", "120 mpg123 " in timeout_log(d), timeout_log(d))
        fin = await client.send_voice_assistant_announcement_await_response("http://127.0.0.1:9/tts.wav", 10, "Kolacja gotowa")
        check(label + ": WAV announcement finished with success", fin.success is True, fin)
        check(label + ": other formats use BusyBox-compatible timeout", "120 gst-play-1.0 " in timeout_log(d), timeout_log(d))
        check(label + ": no GNU-only timeout option", "-t " not in timeout_log(d), timeout_log(d))

        # language picked in the app (settings.json) applies without a restart
        s = d.read_settings(); s["lang"] = "de"
        with open(d.settings_path, "w") as f:
            json.dump(s, f)
        await wait_for(lambda: "settings: lang = de" in d.log(), 6)
        client.send_voice_assistant_timer_event(Tm.VOICE_ASSISTANT_TIMER_STARTED, "t1", "Pizza", 300, 300, True)
        check(label + ": language change applies live (German timer toast)",
              await wait_for(lambda: "Timer „Pizza“: 5 Min." in luna_log(d)), luna_log(d)[-300:])
        client.send_voice_assistant_timer_event(Tm.VOICE_ASSISTANT_TIMER_FINISHED, "t1", None, 300, 0, False)
        check(label + ": unnamed timer toast (German)", await wait_for(lambda: "Timer abgelaufen" in luna_log(d)), luna_log(d)[-300:])
        s.pop("lang")
        with open(d.settings_path, "w") as f:
            json.dump(s, f)
        check(label + ": back to automatic", await wait_for(lambda: "settings: lang = auto -> pl" in d.log(), 6), d.log()[-300:])

        await client.disconnect()
        check(label + ": daemon still running, nothing uncaught", d.proc.poll() is None and "uncaught" not in d.log() and "api: handler" not in d.log(),
              [l for l in d.log().splitlines() if "uncaught" in l or "handler" in l][:3])


def parec_playing(wav_paths, gap_s=2.0):
    """A fake parec that plays the given recordings (16 kHz mono) with silence around them, in real time,
    then stays silent."""
    files = " ".join(shlex.quote(p) for p in wav_paths)
    return ("#!/bin/sh\n"
            "exec python3 -u -c '\n"
            "import sys, time, wave\n"
            "def pcm(p):\n"
            "    w = wave.open(p, \"rb\"); return w.readframes(w.getnframes())\n"
            "gap = bytes(int(%f * 32000) & ~1)\n"
            "data = gap + b\"\".join(pcm(p) + gap for p in sys.argv[1:])\n"
            "t = time.time(); i = 0\n"
            "while True:\n"
            "    chunk = data[i:i + 640] if i < len(data) else bytes(640)\n"
            "    i += 640\n"
            "    sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()\n"
            "    t += 0.02; time.sleep(max(0, t - time.time()))\n"
            "' %s\n") % (gap_s, files)


async def local_wake_suite():
    print("\n== wake word detected on the TV (microWakeWord) ==")
    mww = os.environ.get("LGTV_ASSIST_MWW") or os.path.join(ROOT, "native", "build", "host", "mww")
    models = os.path.join(ROOT, "app", "daemon", "models")
    recordings = os.path.join(os.environ.get("MWW_DEPS") or os.path.join(ROOT, "native", ".deps"), "pymicro-wakeword", "tests")
    if not (os.path.exists(mww) and os.path.exists(os.path.join(models, "okay_nabu.tflite")) and os.path.isdir(recordings)):
        check("detector, models and recordings present (run native/build.sh host and webos)", False, (mww, models, recordings))
        return
    nabu = os.path.join(recordings, "okay_nabu", "1.wav")
    jarvis = os.path.join(recordings, "hey_jarvis", "1.wav")
    fakes = {"luna-send": luna_send("pl-PL"), "pactl": PACTL, "parec": parec_playing([jarvis, nabu])}
    with DaemonHarness(settings={"name": NAME, "api_key": base64.b64encode(os.urandom(32)).decode()}, fakes=fakes) as d:
        client = APIClient("127.0.0.1", d.port, None, noise_psk=d.key, expected_name=NAME)
        await asyncio.wait_for(client.connect(login=True), 15)
        check("status: wake word on the TV, Okay Nabu", (d.status().get("wake") or {}).get("on") == "tv" and d.status()["wake"].get("word") == "Okay Nabu", d.status().get("wake"))
        check("status lists the four models", sorted(m["id"] for m in d.status().get("wakeModels", [])) == ["alexa", "hey_jarvis", "hey_mycroft", "okay_nabu"], d.status().get("wakeModels"))
        voice = Voice(client)
        # 2 s silence, "hey jarvis" (must not wake), 2 s, "okay nabu" (must), ...
        check("nothing is sent to Home Assistant before the wake word", not await wait_for(lambda: voice.starts, 4.5) and not voice.audio, voice.starts)
        check("'Okay Nabu' starts a run on the TV's initiative", await wait_for(lambda: voice.starts, 8), d.log()[-500:])
        check("the run starts at speech-to-text (flags = VAD only)", voice.starts[:1] == [1], voice.starts)
        hits = re.findall(r"wake word: Okay Nabu \d", d.log())
        check("'Hey Jarvis' before it did not wake the TV (one detection, for 'Okay Nabu')", len(hits) == 1, d.log()[-600:])
        await wait_for(lambda: len(voice.audio) >= 32000, 5)
        check("audio after the wake word reaches Home Assistant (%d bytes)" % len(voice.audio), len(voice.audio) >= 32000)
        check("wake word -> Polish 'listening' toast", await wait_for(lambda: "Słucham…" in luna_log(d)), luna_log(d)[-300:])
        client.send_voice_assistant_event(Ev.VOICE_ASSISTANT_RUN_END, None)
        runs = len(voice.starts)
        await asyncio.sleep(3)
        check("after the run nothing more is sent until the next wake word", len(voice.starts) == runs, voice.starts)
        # switching the wake word to Home Assistant: the continuous stream comes back
        s = d.read_settings(); s["wake_word"] = "ha"
        with open(d.settings_path, "w") as f:
            json.dump(s, f)
        check("wake_word 'ha' -> Home Assistant gets a wake word run again", await wait_for(lambda: len(voice.starts) > runs and voice.starts[-1] == 3, 10), voice.starts)
        check("status: wake word by Home Assistant", (d.status().get("wake") or {}).get("on") == "ha", d.status().get("wake"))
        await client.disconnect()
        check("daemon alive, nothing uncaught", d.proc.poll() is None and "uncaught" not in d.log(), d.log()[-300:])

    # a detector that cannot run must not leave the TV deaf
    broken = {"luna-send": luna_send("pl-PL"), "pactl": PACTL, "parec": PAREC}
    os.environ["LGTV_ASSIST_MWW"] = "/bin/false"
    try:
        with DaemonHarness(settings={"name": NAME, "encryption": False}, fakes=broken) as d:
            client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
            await asyncio.wait_for(client.connect(login=True), 15)
            voice = Voice(client)
            ok = await wait_for(lambda: voice.starts and voice.starts[-1] == 3, 25)
            check("a detector that keeps failing -> falls back to Home Assistant's wake word", ok and "giving up on the detector" in d.log(), d.log()[-500:])
            await client.disconnect()
    finally:
        del os.environ["LGTV_ASSIST_MWW"]


async def language_suite():
    print("\n== language fallbacks ==")
    for title, settings, ui, want in [
        ("settings service answers es-ES", {}, "es-ES", "Pantalla"),
        ("settings service answers fr-FR (not translated)", {}, "fr-FR", "Screen"),
        ("no answer, locale reported by the app (de-DE)", {"tv_locale": "de-DE"}, None, "Bildschirm"),
        ("no answer, nothing known", {}, None, "Screen"),
        ("language picked in the app wins over the TV menu", {"lang": "en", "tv_locale": "pl-PL"}, "pl-PL", "Screen"),
    ]:
        with DaemonHarness(settings=dict(settings, name=NAME), fakes={"luna-send": luna_send(ui)}) as d:
            client = APIClient("127.0.0.1", d.port, None, expected_name=NAME)
            await asyncio.wait_for(client.connect(login=True), 15)
            ents, _ = await asyncio.wait_for(client.list_entities_services(), 10)
            names = sorted(e.name for e in ents)
            check(title + " -> " + want, want in names, names)
            await client.disconnect()


async def main():
    await session_suite(True)
    await session_suite(False)
    await local_wake_suite()
    await language_suite()
    print("\n%d passed, %d failed" % (sum(results), len(results) - sum(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
