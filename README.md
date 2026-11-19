# LG TV Assist

Home Assistant voice satellite for rooted LG webOS TVs: push-to-talk with the **Magic Remote mic**.
Home Assistant connects to the TV over the **ESPHome native API**, so there is no token or login on the TV;
the connection is **encrypted** with a key that Home Assistant sets by itself, as for an ESPHome device.
The TV shows up in HA as an `assist_satellite` with a pipeline selector, area, announcements and timers.

The app, its toasts on the TV and the entity names follow the TV menu language: **English, Polish, German, Spanish**
(English for anything else); the language can also be picked in the app.

Tested on: LG OLED55CX (webOS 5.6.2, root via Homebrew Channel), Magic Remote MR20 (BLE), HA 2026.11.

User-tested: **LG 65QNED80SRA** (2023 QNED; TV reports software version **10.3.2**, root via Homebrew
Channel), Magic Remote push-to-talk, Home Assistant 2026.11.2. This is a single user report; it is not a claim
that all QNED models or all devices reporting 10.3.2 work.

![The app on the TV](docs/screenshots/app-running.png)

## Requirements
**TV**
- An LG webOS TV **rooted with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel)**. Root is
  required (developer mode is not enough): the app takes over LG's voice service. Homebrew Channel → Settings must
  show *Root status: ok*. To root a TV, see [webosbrew.org/rooting](https://www.webosbrew.org/rooting/). Which
  method works depends on the TV's firmware.
- webOS 5 (LG CX, 2020) and the user-tested LG 65QNED80SRA (reported software version 10.3.2) have been tried.
  Other webOS versions with Homebrew Channel will probably work, but that is not verified, and compatibility
  should not be assumed for every QNED or 10.3.2 device.
- For **push-to-talk:** a Magic Remote with a microphone button.
- For **hands-free** (wake word): a USB microphone plugged into the TV (any USB audio class device, e.g. a cheap
  C-Media dongle). The CX has no far-field microphone of its own.
- **SSH** enabled in Homebrew Channel (Settings → *SSH Server*) for installing from a computer. The user is `root`;
  the password is `alpine` until you add a key.
- If you use *Life's Good Without Spying* with its voice block on, you also need to turn on the app's two exceptions.
  The app tells you when this is needed (see [Installation](#installation-on-the-tv), step 5).

**Home Assistant**
- The built-in **ESPHome** integration (nothing to install; no ESPHome add-on or Device Builder is needed).
- A **voice assistant** (Settings → Voice assistants) with speech-to-text and text-to-speech in your language,
  e.g. Home Assistant Cloud, Whisper + Piper, or Google.
- Only for wake word mode *by Home Assistant*: a wake word engine such as the openWakeWord add-on. With the
  default, the wake word is detected on the TV.
- Home Assistant must reach the TV on TCP port **6053**. For automatic discovery, mDNS must also work between them,
  i.e. the same network or an mDNS reflector.

## Installation on the TV
The app is not in the default Homebrew Channel repository yet, so it is installed from an `.ipk` file. Each
[GitHub release](https://github.com/xrogers/lgvoiceassist/releases/latest) carries
`io.github.xrogers.lgtvassist_<version>_all.ipk` and `SHA256SUMS`. You can also build it yourself
(see [Build from source](#build-from-source)).

1. **Download** the `.ipk` from the latest release (and check it with `sha256sum -c SHA256SUMS --ignore-missing`).
2. **Install** it with one of:
   - **SSH** (the TV's IP address is under *Settings → Network*):
     ```sh
     scp io.github.xrogers.lgtvassist_*_all.ipk root@TV:/tmp/lgtvassist.ipk
     ssh root@TV 'luna-send -i luna://com.webos.appInstallService/dev/install \
       "{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"/tmp/lgtvassist.ipk\",\"subscribe\":true}"'
     ```
     `luna-send` prints the progress. When a message with `"state":"installed"` (`"statusValue":30`) appears,
     press Ctrl+C. The file in `/tmp` is deleted when the TV restarts.
   - **[webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop)** (desktop app): add the TV as a rooted
     device (port 22, user `root`), then *Apps → Install* and pick the `.ipk`.
3. **Open LG TV Assist** from the TV's app list. On the first run the service has no root yet:

   ![First run: Grant root access](docs/screenshots/app-first-run.png)

   Select **Grant root access (Homebrew)**. The app asks Homebrew Channel to elevate its service, then starts it.
   The service installs the boot hook `/var/lib/webosbrew/init.d/60-lgtv-assist`, so from then on it starts by
   itself whenever the TV starts. If the app asks you to, open it again.
4. The card **Service on the TV** now says *running*, and the hint tells you how to add the TV to Home Assistant:

   ![Waiting for Home Assistant](docs/screenshots/app-waiting.png)

5. *Life's Good Without Spying* only: if it blocks the voice services, a yellow card appears. Select **Open Life's
   Good Without Spying**, turn on *LG TV Assist: voiceinput* and *LG TV Assist: voiceconductor* under
   **Exceptions**, then apply the changes.

**Updating:** install the new `.ipk` the same way (the settings and the encryption key are kept). Then open the app
and select **Grant root access (Homebrew)** again, because every manual install resets the service to non-root.
After that select **Restart**. Apps installed from a Homebrew Channel repository are re-elevated automatically; a
manual install is not.

**Uninstalling:** select **Turn off** in the app (this hands the mic button back to LG's assistant), then remove the
app from the TV's app list. The boot hook deletes itself on the next start once the app is gone. To also remove the
settings and the key, delete `/media/developer/lgtv-assist/`. In Home Assistant, delete the "LG TV" device or its
ESPHome entry.

## Setting up in Home Assistant
1. **Add the TV.** Go to **Settings → Devices & services**. The TV appears under *Discovered* as an ESPHome device
   named **LG TV**. Select **Add** and confirm. If it does not appear (e.g. no mDNS across networks), select
   **Add integration → ESPHome** and enter the TV's IP address with port **6053**.
   - There is **no encryption key to type**. Home Assistant generates a key and hands it to the TV while adding it
     (see [Encryption](#encryption)). Leave the key field empty if you are asked for one.
   - In the app, *Home Assistant* changes to *connected* and **Encryption** to *on*.
2. **Pick the area.** Home Assistant asks for an area while adding the device. The voice assistant uses it to resolve
   commands such as "turn on the lights" without a room name.
3. **Choose the assistant** on the device page (**Settings → Devices & services → ESPHome → LG TV**):

   ![The TV's device page in Home Assistant](docs/screenshots/ha-device.png)

   - **Assistant** selects the voice assistant (pipeline) that this TV uses. *Preferred* is the one starred under
     Settings → Voice assistants. *Assistant 2* is for a second wake word, which the TV does not use.
   - **Finished speaking detection** sets how long a pause ends the command (hands-free).
   - **Wake word** / **Wake word 2** stay *unavailable*: choose the wake word on the TV instead (the app's
     **Wake word** button; see [Wake word on the TV](#wake-word-on-the-tv)).
   - **Assist satellite** is the voice entity. Announcements (`assist_satellite.announce`), timers set by voice,
     and the *Set up voice assistant* wizard all use it.
   - **Media Player** plays TTS, announcements and audio URLs through the TV's speakers
     (`media_player.play_media`, `tts.speak`). It does not control the TV itself; LG's own *webOS TV* integration
     does that.
   - **Screen** turns the TV's picture on or off; the sound keeps playing. With *Wake screen: on* in the app, the
     wake word turns the picture on.
4. **Voice assistant settings** (Settings → Voice assistants → your assistant):
   - The speech-to-text **language** should match how you speak to the TV. The TV's toasts and entity names follow
     the TV menu language, independently of this.
   - If you choose wake word *by Home Assistant* in the app, the TV streams the microphone to Home Assistant all
     the time. The assistant then needs a **wake word engine**, and its wake word setting applies. This is not
     needed for the default on-TV wake word.
   - If you use an LLM conversation agent, consider not exposing `media_player.lg_tv_media_player` to it
     (Settings → Voice assistants → Expose). Otherwise the agent may pick it for "play …" requests that belong to
     your music player.

**Using it:** hold the remote's **mic button**, speak, then release. With a USB microphone, say the wake word
(*Okay Nabu* by default) followed by the command; the TV lowers its volume while it listens. The reply is spoken
through the TV and also shown as a toast (the app's **Toasts** button controls the toasts). The app's
*Last conversation* card shows what was understood and the answer; **Full reply** shows the whole text.

## How it works
1. **Mic button:** `com.webos.starfish.keyfilters` sends the mic key to `com.webos.service.voiceconductor`
   (`//setInputEvent {"event":"down"|"up","inputType":"hold"}`). The daemon holds that luna name; LG's
   voiceconductor is stopped and bind-mounted with an `exit 0` stub. `/dev/input` is grabbed, so evdev can't be used.
2. **Audio:** the daemon calls LG `voiceinput/startStreaming {keyType:"thinQtv",subscribe:true,deviceType:"remote"}`
   *through its own voiceconductor handle* (voiceinput only lets the starter stop: `stopStreaming`, otherwise "permission fail").
   voiceinput sends the remote the HID feature report `F9 03` (stop `F9 04`, keep-alive `F9 05` via `restartTimer`),
   decodes the remote's mSBC and serves raw **PCM s16le 16 kHz mono** on `/tmp/voiceinput_remote1.soc`.
3. **Home Assistant:** ESPHome API server on port 6053 (plaintext or Noise-encrypted, see below) plus an mDNS responder for `_esphomelib._tcp`, so HA
   auto-discovers it. Push-to-talk: `VoiceAssistantRequest(start)` → `VoiceAssistantAudio` chunks → `VoiceAssistantAudio(end)` on release.
   Replies, announcements and media_player URLs play through `mpg123` (MP3 is declared as the supported format) or `gst-play-1.0`.

## Layout
```
app/                                  packaged into the .ipk
  index.html, app.js                  webOS app (UI)
  i18n.js                             translations, shared by the UI and the daemon
  daemon/satellite.js                 ESPHome satellite daemon (Node 8, no npm deps)
  daemon/lib/{pb,messages,mdns}.js    protobuf codec, API message subset, mDNS responder
  daemon/lib/noise.js                 API encryption: X25519, ChaCha20-Poly1305, Noise handshake, framing
  daemon/bin/mww, daemon/models/      wake word detector and models (built by native/build.sh, not in git)
  daemon/{autostart,loop,stop,init-hook}.sh
  services/io.github.xrogers.lgtvassist.service/
    service.js                        luna service: status/start/stop/restart/setSettings (runs as root)
native/mww.cc, native/build.sh        the wake word detector and its build
tools/build_ipk.py                    builds dist/*.ipk + the Homebrew Channel manifest (no ares-cli needed)
tools/check_i18n.js                   checks that all translations are complete and used
tools/test_*.{js,py}, daemon_harness* tests (see below)
tools/make_icons.py                   draws the icons
tools/app_screenshots.py              renders docs/screenshots/app-*.png from the real UI
legacy/                               first prototype (TV → HA WebSocket with a token)
.github/workflows/release.yml         CI build; a tag vX.Y.Z publishes a GitHub release
```

## Build from source
```sh
native/build.sh webos                           # wake word detector + models (optional; without it HA detects the wake word)
python3 tools/build_ipk.py                      # → dist/io.github.xrogers.lgtvassist_<ver>_all.ipk (+ manifest)
```
Then install `dist/*.ipk` as described in [Installation](#installation-on-the-tv). "Grant root access" calls
`org.webosbrew.hbchannel.service/elevateService` for the service and then starts it.

The screenshots in `docs/screenshots/app-*.png` are rendered from the real UI with example data:
`tools/app_screenshots.py` (needs Playwright).

## Wake word on the TV
With a USB microphone the TV listens for the wake word **itself** (microWakeWord, the engine of ESPHome voice
devices such as Home Assistant Voice PE): nothing leaves the TV until it hears the word, then the audio goes to Home
Assistant, starting at speech-to-text. The app's **Wake word** button picks *Okay Nabu* (default), *Hey Jarvis*,
*Hey Mycroft* or *Alexa*, or *by Home Assistant*: the microphone is then streamed to Home Assistant all the time
and its wake word engine (e.g. openWakeWord) listens, as before 0.7.

- `app/daemon/bin/mww` is a small native program (`native/mww.cc`): TensorFlow Lite Micro plus TensorFlow's audio
  "microfrontend", reading 16 kHz audio on stdin and printing `wake <model> <probability>`. On the TV it uses
  about 2 % of one core per model and 1 MB of memory.
- `native/build.sh webos` builds it with the webOS toolchain (openlgtv/buildroot-nc4) as a 32-bit ARM binary and
  copies the models (from pymicro-wakeword) to `app/daemon/models/`; `native/build.sh host` builds it for tests.
  All third-party code is fetched at pinned versions; licences: `app/daemon/bin/THIRD_PARTY_LICENSES.txt`.
- It gives the same results as pymicro-wakeword, the reference implementation (`tools/test_wakeword.py`): the model
  input is bit-identical, and every model output is bit-identical to TensorFlow Lite's reference kernels.
  pymicro-wakeword runs TensorFlow Lite's optimised kernels, which round a little differently (194 of 5965 outputs
  differ on its test recordings, by at most 21/255); every recording is detected or rejected the same way.
- The frontend's lookup tables are computed with the C library's float functions, and the TV's older libm rounds
  a few entries differently. The TV build therefore carries the tables computed on the build machine
  (`mww --dump-tables`), so the TV's output is bit-identical to the build machine's.
- If the detector cannot run (or keeps stopping), the TV falls back to Home Assistant's wake word by itself.

## Encryption
The connection is encrypted with `Noise_NNpsk0_25519_ChaChaPoly_SHA256`, the ESPHome API encryption, and nobody has
to type a key: as with an ESPHome device that has no key yet, **Home Assistant makes the key and hands it to the TV**
the first time it connects (over a short Noise session with the all-zero key, so the key never crosses the network in
the clear; Home Assistant older than that sends it over the plaintext session). From then on the TV accepts only
connections that prove this key. Until Home Assistant has done so, the app shows *Encryption: waiting for Home
Assistant* and the TV still answers in plaintext.

- The key lives in `/media/developer/lgtv-assist/settings.json` (`api_key`, base64 of 32 bytes); the app never shows it.
- **Encryption: off** in the app makes the TV plaintext-only and drops the key; Home Assistant then asks to confirm
  that encryption was removed. Turning it on again lets Home Assistant set a new key.
- To move the TV to another Home Assistant, turn encryption off and on once.
- Without encryption anyone on the home network can connect to port 6053, play media on the TV and, in hands-free
  mode, receive the microphone audio.

The TV's Node 8 / OpenSSL 1.0.2 has neither X25519 nor ChaCha20-Poly1305, so both are implemented in plain JavaScript
in `app/daemon/lib/noise.js` (X25519 after TweetNaCl, public domain).

## Tests
```sh
node tools/check_i18n.js                 # translations complete and used
node tools/test_noise.js                 # crypto test vectors (RFC 7748, RFC 8439), Noise handshake, framing; runs on Node 8
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install aioesphomeapi cryptography
/tmp/venv/bin/python tools/test_interop.py      # the real daemon against the real Home Assistant client library (encryption, key hand-over)
/tmp/venv/bin/python tools/test_voice.py        # voice audio, events, announcements, languages; encrypted and plaintext
/tmp/venv/bin/python tools/test_crypto_diff.py  # X25519 / ChaCha20-Poly1305 against OpenSSL on random inputs
native/build.sh host && /tmp/venv/bin/pip install pymicro-wakeword==2.5.0 ai-edge-litert
/tmp/venv/bin/python tools/test_wakeword.py     # wake word detector against the reference implementation
```
`tools/daemon_harness.py` runs the unmodified daemon off-TV (stub `palmbus`, fake `luna-send`/`pactl`/`parec`, temp
directories). `LGTV_NODE=/path/to/node` picks the Node binary, e.g. Node 8.12 as on the TV.

## Translations
All texts live in `app/i18n.js`. To add a language, copy the `en` block under a new two-letter code, translate the
values (keep the `{placeholders}` and `<b>` tags), add the code to `LANGS` and its name to `NAMES`, then run
`node tools/check_i18n.js`. The language is the one chosen in the app, otherwise the TV menu language
(`localeInfo.locales.UI` from LG's settings service, or the locale the app reported when it was last opened).

## Releases
The version is kept in three places, and the build fails if they differ: `app/appinfo.json`,
`app/services/*/package.json` and `VERSION` in `app/daemon/satellite.js`.
```sh
git tag v0.5.4 && git push origin v0.5.4       # the tag must match that version
```
The workflow then publishes `io.github.xrogers.lgtvassist_<ver>_all.ipk`, `io.github.xrogers.lgtvassist.manifest.json`
and `SHA256SUMS` as a GitHub release. The manifest is what a Homebrew Channel repository entry points at
(`https://github.com/xrogers/lgvoiceassist/releases/latest/download/io.github.xrogers.lgtvassist.manifest.json`).
Builds are reproducible: the commit time is used as the timestamp of every archive entry.

## Notes
- Children are started through `spawnClean` (closes inherited fds); otherwise a lingering child keeps the luna hub
  socket and the voiceconductor name stays "already exists" after a restart.
- Audio playback uses `timeout 120 …`, which both BusyBox and GNU coreutils accept. The BusyBox 1.35 on the
  user-tested TV rejects GNU's `timeout -t`, which would make TTS, announcements and media URLs silent.
- Turning the app off (or uninstalling it and rebooting) gives the mic button back to LG's assistant.
- Data/settings: `/media/developer/lgtv-assist/` (`settings.json`, `disabled` flag). Logs: `/tmp/lgtv-assist.log`.
- Remote protocol (MR20, BLE, `hidraw` only while awake): voice report `0xFE`, 124 B = `FE seq 80 8B` + 2 × (`01 H2` + 57 B mSBC + pad).

## TODO
- Start TTS playback early from the streaming URL in `RUN_START`.
- Listing in the Homebrew Channel repository (webosbrew/apps-repo) for one-click install and auto re-elevation.
