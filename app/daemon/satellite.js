// LG TV Assist: makes a rooted LG webOS TV an ESPHome voice satellite for Home Assistant.
//
//  * Home Assistant connects to us (ESPHome native API, plaintext or Noise-encrypted, port 6053) and finds us via mDNS
//    (_esphomelib._tcp). No token or login on the TV.
//  * Push-to-talk on the Magic Remote mic button: we hold the luna name com.webos.service.voiceconductor
//    (LG's service is stopped), so keyfilters sends us //setInputEvent down/up.
//  * Audio: LG's voiceinput streams the remote mic (HID F9 03 / F9 04, mSBC decoded by LG) as raw
//    PCM s16le 16 kHz mono on a unix socket; we forward it as VoiceAssistantAudio.
//  * Replies, announcements and media_player URLs are played with mpg123 (MP3) or gst-play-1.0.
//  * Toasts and the entity name follow the TV menu language (English, Polish, German, Spanish).
//  * Hands-free with a USB microphone: the wake word is detected on the TV (bin/mww, microWakeWord) or,
//    without that detector, by Home Assistant from a continuous stream.
//
// Node 8 (TV firmware), no npm dependencies. Runs as root (needs luna name + LG service control).
'use strict';
var palmbus = require('palmbus');
var net = require('net'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var pb = require('./lib/pb'), msgs = require('./lib/messages'), Mdns = require('./lib/mdns'), noise = require('./lib/noise');
var I18N = require('../i18n');   // translations shared with the app UI (app folder)
var M = msgs.M, E = msgs.E;

var VERSION = '0.7.0';
var DATA_DIR = process.env.LGTV_ASSIST_DATA || '/media/developer/lgtv-assist';
// LGTV_ASSIST_TMP: prefix of the log/status/pid files (default keeps the paths the TV service reads); for tests
var TMP = process.env.LGTV_ASSIST_TMP || '/tmp/lgtv-assist';
var LOG = TMP + '.log';
var STATUS = TMP + '.status.json';

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }
var CFG = Object.assign({ name: 'lg-tv-assist', friendly_name: 'LG TV', port: 6053, max_seconds: 15,
  toasts: true, suggested_area: '', hands_free: true, mic_gain: 85, duck: true, duck_volume: 5, wake_screen: true }, readJson(path.join(DATA_DIR, 'settings.json'), {}));

function log() {
  var s = new Date().toISOString().slice(11, 23) + ' ' + Array.prototype.join.call(arguments, ' ');
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, s + '\n');
  } catch (e) {}
  if (process.stdout.isTTY) console.log(s);
}

// ------------------------------------------------------------------ network identity
function netInfo() {
  var ifs = os.networkInterfaces(), best = null;
  Object.keys(ifs).forEach(function (n) {
    ifs[n].forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address) && !best) best = { ip: a.address, mac: a.mac, ifname: n };
    });
  });
  return best || { ip: '0.0.0.0', mac: '00:00:00:00:00:00', ifname: '?' };
}
var NET = netInfo();
var MAC = NET.mac.toUpperCase();

// ------------------------------------------------------------------ status (for the app UI)
var status = { mic: 'starting', usbMic: null, listening: false, version: VERSION, started: new Date().toISOString(), ip: NET.ip, port: CFG.port, name: CFG.name,
  ha: null, haSince: null, lastSession: null, lastText: null, lastReply: null, lastError: null };
function saveStatus() { try { fs.writeFileSync(STATUS, JSON.stringify(status)); } catch (e) {} }
saveStatus();
try { fs.writeFileSync(TMP + '.daemon.pid', String(process.pid)); } catch (e) {}

// ------------------------------------------------------------------ child processes
// Children must not inherit our luna hub socket (palmbus fds lack CLOEXEC); a child outliving us
// keeps the voiceconductor name registered and we could not come back after a restart.
var CLOSE_FDS = 'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';
function spawnClean(cmd, args, opts) { return cp.spawn('/bin/sh', ['-c', CLOSE_FDS, 'sh', cmd].concat(args), opts || {}); }

function lunaSend(uri, params) {
  spawnClean('luna-send', ['-n', '1', '-w', '3000', uri, JSON.stringify(params)], { stdio: 'ignore' }).on('error', function () {});
}
// CFG.toasts: true = all toasts, 'listen' = only the "listening" toast after the wake word, false = none
function toast(text, kind) {
  if (!text) return;
  if (CFG.toasts === false) return;
  if (CFG.toasts === 'listen' && kind !== 'listen') return;
  lunaSend('luna://com.webos.notification/createToast',
    { message: String(text).slice(0, 180), sourceId: 'com.webos.service.voiceconductor', noaction: true });
}

// ------------------------------------------------------------------ language
// CFG.lang: a language picked in the app. Otherwise the TV menu language: from LG's settings service
// (live, see watchLocale) or, failing that, as the app reported it when it was last opened (CFG.tv_locale).
var tvLocale = null;
function lang() { return I18N.resolve(CFG.lang, tvLocale || CFG.tv_locale); }
function T(key, params) { return I18N.t(lang(), key, params); }
function watchLocale(onFirst) {
  var p = spawnClean('luna-send', ['-i', 'luna://com.webos.settingsservice/getSystemSettings', '{"keys":["localeInfo"],"subscribe":true}']);
  var buf = '';
  p.stdout.on('data', function (d) {
    buf = (buf + d).slice(-8192);
    var re = /"UI"\s*:\s*"([A-Za-z_-]+)"/g, m, last = null, end = 0;   // localeInfo.locales.UI, e.g. "pl-PL"
    while ((m = re.exec(buf))) { last = m[1]; end = re.lastIndex; }
    if (!last) return;
    buf = buf.slice(end);
    if (last !== tvLocale) { tvLocale = last; log('language: TV menu', last, '->', lang()); }
    if (onFirst) { var cb = onFirst; onFirst = null; cb(); }
  });
  p.on('error', function () {});
  p.on('exit', function () { setTimeout(function () { watchLocale(onFirst); }, 30000); });
}

// ------------------------------------------------------------------ luna: be "voiceconductor"
var VC = 'com.webos.service.voiceconductor';
var APP_ID = 'io.github.xrogers.lgtvassist';
var VC_ANSWERS = { '/': { setInputEvent: {}, getSupportedLanguages: { voiceEngines: {}, voiceLanguages: {} } },
  '/interactor': { register: { subscribed: true } } };
var handles = null;

// Life's Good Without Spying may answer for voiceconductor with its own stand-in. With our "claim"
// exception turned on, it steps aside for the process named in its claim file (pid, start time, app id;
// the process must run from our app folder). Without it we don't fight the stand-in.
var NOSPY_ANSWER_PID = '/tmp/lifesgoodwithoutspying.answer.' + VC + '.pid';
var NOSPY_CLAIM = '/tmp/lifesgoodwithoutspying.claim.' + VC;
var NOSPY_APPLIED = '/var/lib/webosbrew/lifesgoodwithoutspying.conf-applied';
function procStartTime(pid) {
  var st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return st.slice(st.lastIndexOf(')') + 2).split(' ')[19];
}
function nospyClaimAllowed() {
  try {
    return fs.readFileSync(NOSPY_APPLIED, 'utf8').split('\n')
      .indexOf('exception.' + APP_ID + ':claim:' + VC + '=on') >= 0;
  } catch (e) { return false; }
}
function nospyStandIn() {
  try {
    var pid = parseInt(fs.readFileSync(NOSPY_ANSWER_PID, 'utf8'), 10);
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').indexOf('nospy-luna-stub.js') >= 0 ? pid : 0;
  } catch (e) { return 0; }
}
function nospyClaim() {
  var stand = nospyStandIn();
  if (!stand) return false;
  if (!nospyClaimAllowed()) { status.mic = 'blocked by Life\'s Good Without Spying (turn on the LG TV Assist exception)'; saveStatus(); return false; }
  try { fs.writeFileSync(NOSPY_CLAIM, process.pid + ' ' + procStartTime(process.pid) + ' ' + APP_ID + '\n'); } catch (e) { return false; }
  try { process.kill(stand, 'SIGTERM'); } catch (e) {}
  log('nospy: claimed', VC, '- stopped its stand-in', stand);
  return true;
}

function onVcRequest(msg) {
  var body = {}; try { body = JSON.parse(msg.payload() || '{}'); } catch (e) {}
  var r = JSON.parse(JSON.stringify((VC_ANSWERS[msg.category()] || {})[msg.method()] || {}));
  r.returnValue = true; msg.respond(JSON.stringify(r));
  if (msg.method() === 'setInputEvent') {
    if (body.event === 'down') pttDown(); else if (body.event === 'up') pttUp();
  }
}

function registerVc(attempt) {
  attempt = attempt || 0;
  try {
    var hs = [false, true].map(function (pub) {
      var h = new palmbus.Handle(VC, pub);
      Object.keys(VC_ANSWERS).forEach(function (cat) {
        Object.keys(VC_ANSWERS[cat]).forEach(function (m) { h.registerMethod(cat, m); });
      });
      h.addListener('request', onVcRequest);
      return h;
    });
    handles = hs;
    status.mic = 'ok'; saveStatus();
    log('registered', VC);
  } catch (e) {
    if (attempt === 0) log('luna:', VC, 'is taken (' + e.message + '); retrying');
    nospyClaim();
    setTimeout(function () { registerVc(attempt + 1); }, attempt < 10 ? 1000 : 10000);
  }
}
registerVc();
log('lgtv-assist', VERSION, 'ip', NET.ip, 'mac', MAC);

// ------------------------------------------------------------------ remote mic (LG voiceinput)
var VI = 'luna://com.webos.service.voiceinput/', VI_PARAMS = { keyType: 'thinQtv', deviceType: 'remote' };
function viCall(method, cb) {
  if (!handles) { if (cb) cb('{"returnValue":false}'); return; }
  var c = handles[0].call(VI + method, JSON.stringify(VI_PARAMS));
  c.addListener('response', function (m) { if (cb) cb(m.payload()); });
}

function Mic(onData, onOpen, onFail) {
  this.onData = onData; this.onOpen = onOpen; this.onFail = onFail;
  this.sub = null; this.sock = null; this.keep = null; this.closed = false; this.t0 = Date.now();
  this.open(0);
}
Mic.prototype.open = function (attempt) {
  var self = this;
  if (this.closed) return;
  if (!handles) return this.onFail && this.onFail('voiceconductor name not held');
  var c = handles[0].subscribe(VI + 'startStreaming', JSON.stringify({ keyType: 'thinQtv', subscribe: true, deviceType: 'remote' }));
  this.sub = c;
  c.addListener('response', function (m) {
    var r = {}; try { r = JSON.parse(m.payload()); } catch (e) {}
    if (self.closed) return;
    if (r.returnValue === false && !self.sock) {
      try { c.cancel(); } catch (e) {}
      // remote may still be reconnecting (BLE) or the previous stream winding down
      if (attempt < 15) return setTimeout(function () { self.open(attempt + 1); }, 200);
      log('mic: voiceinput refused:', r.errorText || JSON.stringify(r));
      return self.onFail && self.onFail(r.errorText || 'mic unavailable');
    }
    if (r.socketPath && !self.sock) {
      self.sock = net.connect(r.socketPath);
      self.sock.on('data', function (pcm) { if (!self.closed) self.onData(pcm); });
      self.sock.on('error', function (e) { log('mic socket error', e.message); });
      self.keep = setInterval(function () { viCall('restartTimer'); }, 2500);
      log('mic: open after', Date.now() - self.t0, 'ms');
      if (self.onOpen) self.onOpen();
    }
  });
};
Mic.prototype.close = function () {
  if (this.closed) return;
  this.closed = true;
  clearInterval(this.keep);
  if (this.sock) { try { this.sock.destroy(); } catch (e) {} }
  var sub = this.sub, opened = !!this.sock;
  // Stop as the same client that started, then drop the subscription. Also when the socket isn't
  // open yet: voiceinput may already be capturing, and would refuse the next start for seconds.
  viCall('stopStreaming', function (out) {
    if (opened && !/"returnValue"\s*:\s*true/.test(out)) log('mic: stopStreaming', out);
    try { if (sub) sub.cancel(); } catch (e) {}
  });
};

// ------------------------------------------------------------------ player
var MP_KEY = 0x4c475456;   // 'LGTV'
var player = { proc: null, queue: [], state: E.MP_STATE.IDLE, volume: 1.0, muted: false, announcing: false, done: null };

function playUrls(urls, announcement, done) {
  stopPlayback(true);
  if (session && session.type === 'wake' && !session.woke) abortSession('playback');
  player.queue = urls.filter(Boolean);
  player.announcing = !!announcement;
  player.done = done || null;
  // HA's ESPHome media_player maps only idle/playing/paused (ANNOUNCING raised KeyError and stalled the entry)
  setPlayerState(E.MP_STATE.PLAYING);
  playNext();
}
function playNext() {
  var url = player.queue.shift();
  if (!url) {
    player.proc = null;
    setPlayerState(E.MP_STATE.IDLE);
    var cb = player.done; player.done = null;
    if (cb) cb(true); else scheduleListening(300);
    return;
  }
  var scale = player.muted ? 0 : Math.round(32768 * player.volume);
  var p = /\.mp3(\?|$)/i.test(url) || !/\.(flac|wav|ogg|opus)(\?|$)/i.test(url)
    ? spawnClean('timeout', ['120', 'mpg123', '-q', '-f', String(scale), url], { stdio: 'ignore' })
    : spawnClean('timeout', ['120', 'gst-play-1.0', '-q', '--volume=' + (player.muted ? 0 : player.volume), url], { stdio: 'ignore' });
  player.proc = p;
  p.on('error', function () {});
  p.on('exit', function () { if (player.proc === p) playNext(); });
}
function stopPlayback(silent) {
  player.queue = [];
  var p = player.proc; player.proc = null;
  if (p) { try { p.kill(); } catch (e) {} }
  var cb = player.done; player.done = null;
  if (cb) cb(false);
  if (!silent) setPlayerState(E.MP_STATE.IDLE);
}
function setPlayerState(st) { player.state = st; broadcast('MediaPlayerStateResponse', playerStateMsg()); }
function playerStateMsg() { return { key: MP_KEY, state: player.state, volume: player.volume, muted: player.muted }; }

// ------------------------------------------------------------------ API encryption (Noise)
// As with an ESPHome device, Home Assistant sets the key itself, so nobody has to type it:
//  * encryption wanted (CFG.encryption !== false, the default) but no key yet = "unprovisioned": plaintext
//    still works, we announce api_encryption_supported + api_encryption_provisionable, and a client may open
//    a Noise session with the all-zero key to hand over the real one (NoiseEncryptionSetKeyRequest) without
//    it crossing the network in the clear. Home Assistant does this on its own when it connects.
//  * key present (CFG.api_key, base64 of 32 bytes): only Noise_NNpsk0_25519_ChaChaPoly_SHA256 connections
//    that prove this key are accepted.
//  * CFG.encryption === false: plaintext only; encryption is not announced, so no key is set.
var ENC_WANTED = CFG.encryption !== false;
var API_KEY = ENC_WANTED ? noise.parseKey(CFG.api_key) : null;
if (ENC_WANTED && CFG.api_key && !API_KEY) log('api: api_key in settings.json is not a usable key; waiting for a new one');
var ZERO_PSK = Buffer.alloc(32);
var HELLO_TIMEOUT_MS = 20000;   // an encrypted client must finish the handshake within this time
function encrypted() { return !!API_KEY; }
function provisionable() { return ENC_WANTED && !API_KEY; }
function encStatus() { status.encryption = encrypted(); status.provisionable = provisionable(); saveStatus(); }
encStatus();
// mDNS TXT records as an ESPHome device sets them
function encTxt(txt) {
  delete txt.api_encryption; delete txt.api_encryption_supported; delete txt.api_provisioning;
  if (encrypted()) txt.api_encryption = noise.NOISE_NAME;
  else if (provisionable()) { txt.api_encryption_supported = noise.NOISE_NAME; txt.api_provisioning = 'zero-psk'; }
}

// Stores the key (base64 text) in settings.json, or removes it (null); the other settings stay.
function saveKey(key) {
  try {
    var sf = path.join(DATA_DIR, 'settings.json'), cur = readJson(sf, {}), tmpf = sf + '.tmp';
    if (key) cur.api_key = key; else delete cur.api_key;
    fs.writeFileSync(tmpf, JSON.stringify(cur, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmpf, sf);
    return true;
  } catch (e) {
    log('api: could not save settings.json (' + e.message + ')');
    return false;
  }
}

// NoiseEncryptionSetKeyRequest: key = base64 text of 32 bytes; empty = remove the key (back to unprovisioned).
// Accepted while unprovisioned (any session, like ESPHome) or on a session that proved the current key.
function onSetKey(client, m) {
  var text = m.key && m.key.length ? m.key.toString('latin1') : '', key = text ? noise.parseKey(text) : null, ok = false;
  if (!ENC_WANTED) log('api: key refused: encryption is turned off in the app');
  else if (!provisionable() && !(client.noise && !client.zeroKey)) log('api: key refused: this session did not prove the current key');
  else if (text && !key) log('api: key refused: not base64 of 32 bytes (or all zeros)');
  else ok = saveKey(text || null);
  client.send('NoiseEncryptionSetKeyResponse', { success: ok });
  if (!ok) return;
  log('api: encryption key ' + (key ? 'set' : 'removed') + ' by', client.name, '@', client.sock.remoteAddress,
    client.noise ? '(over Noise)' : '(over plaintext)');
  // like ESPHome: the answer goes out first, then every session from before the change is closed
  setTimeout(function () {
    API_KEY = key; CFG.api_key = key ? text : undefined;
    encStatus(); encTxt(TXT); mdns.announce();
    log('api: encryption is now', encrypted() ? 'on' : 'waiting for a key', '- closing', clients.length, 'connection(s)');
    clients.slice().forEach(function (c) {
      try { c.send('DisconnectRequest', {}); } catch (e) {}
      c.sock.end();
      setTimeout(function () { c.sock.destroy(); }, 1000);
    });
  }, 100);
}

function attachNoise(c, psk) {
  var sock = c.sock;
  c.noise = new noise.Transport({ psk: psk, name: CFG.name, mac: MAC.replace(/:/g, '').toLowerCase(),
    write: function (b) { if (!sock.destroyed) sock.write(b); },
    onPacket: function (type, data) { c.dispatch(type, data); },
    onReady: function () { clearTimeout(c.hsTimer); },
    onClose: function (why) {
      clearTimeout(c.hsTimer);
      log('api: closing', sock.remoteAddress + ':', why);
      sock.end(); setTimeout(function () { sock.destroy(); }, 2000);
    } });
  c.hsTimer = setTimeout(function () { if (!c.noise.isReady()) c.noise.close('handshake timeout'); }, HELLO_TIMEOUT_MS);
}

// ------------------------------------------------------------------ ESPHome API server
var clients = [];          // connected API clients
var va = null;             // client subscribed to voice assistant

function Client(sock) {
  this.sock = sock; this.buf = Buffer.alloc(0); this.name = '?'; this.subscribedStates = false;
  this.noise = null;      // Noise transport; null = plaintext framing
  this.zeroKey = false;   // Noise session with the all-zero key (provisioning only)
  this.frames = 0; this.hsTimer = null;
  clients.push(this);
}
Client.prototype.send = function (type, obj) {
  if (this.sock.destroyed) return;
  var def = M[type], body = pb.encode(def[1], obj || {}), hdr = [0];
  if (this.noise) { this.noise.send(def[0], body); return; }
  pb.writeVarint(hdr, body.length); pb.writeVarint(hdr, def[0]);
  this.sock.write(Buffer.concat([Buffer.from(hdr), body]));
};
Client.prototype.onData = function (d) {
  if (this.noise) return this.noise.receive(d);
  if (this.rejected) return;
  this.buf = Buffer.concat([this.buf, d]);
  while (this.buf.length >= 3) {
    if (this.buf[0] === 1 && !this.frames && provisionable()) {
      // No key yet: a client may open a Noise session with the all-zero key to hand over the real one
      log('api: zero-key Noise session from', this.sock.remoteAddress);
      var all = this.buf; this.buf = Buffer.alloc(0);
      this.zeroKey = true; attachNoise(this, ZERO_PSK);
      return this.noise.receive(all);
    }
    if (this.buf[0] !== 0) {
      // like a plaintext ESPHome device: "\0Bad indicator byte" tells a Noise client that we speak plaintext
      log('api: encrypted client but encryption is off; told it we use plaintext');
      this.rejected = true; this.sock.end(noise.PLAIN_BAD_INDICATOR);
      var s = this.sock; setTimeout(function () { s.destroy(); }, 2000);
      return;
    }
    var r1, r2;
    try { r1 = pb.readVarint(this.buf, 1); r2 = pb.readVarint(this.buf, r1[1]); } catch (e) { return; }
    var len = r1[0], type = r2[0], start = r2[1];
    if (this.buf.length < start + len) return;
    var payload = this.buf.slice(start, start + len);
    this.buf = this.buf.slice(start + len);
    this.frames++;
    this.dispatch(type, payload);
  }
};
Client.prototype.dispatch = function (type, payload) {
  var name = msgs.byId[type];
  if (!name) return;
  var msg = {};
  try { msg = pb.decode(M[name][1], payload); } catch (e) { log('api: decode', name, e.message); return; }
  try { this.handle(name, msg); } catch (e) { log('api: handler', name, e.stack); }
};
Client.prototype.handle = function (name, m) {
  var self = this;
  switch (name) {
    case 'HelloRequest':
      this.name = m.client_info || '?';
      return this.send('HelloResponse', { api_version_major: 1, api_version_minor: 10, server_info: 'lgtv-assist ' + VERSION, name: CFG.name });
    case 'AuthenticationRequest': return this.send('AuthenticationResponse', {});
    case 'DisconnectRequest': this.send('DisconnectResponse', {}); return this.sock.end();
    case 'PingRequest': return this.send('PingResponse', {});
    case 'DeviceInfoRequest':
      return this.send('DeviceInfoResponse', {
        name: CFG.name, friendly_name: CFG.friendly_name, mac_address: MAC, esphome_version: '2025.9.0',
        model: 'LG webOS TV (Magic Remote mic)', manufacturer: 'LG Electronics', project_name: 'lgtv-assist.LG TV Assist',
        project_version: VERSION, suggested_area: CFG.suggested_area,
        api_encryption_supported: ENC_WANTED, api_encryption_provisionable: provisionable(),
        voice_assistant_feature_flags: E.VA_FEATURE.VOICE_ASSISTANT | E.VA_FEATURE.API_AUDIO | E.VA_FEATURE.ANNOUNCE |
          E.VA_FEATURE.START_CONVERSATION | E.VA_FEATURE.TIMERS });
    case 'ListEntitiesRequest':
      this.send('ListEntitiesMediaPlayerResponse', {
        object_id: 'lg_tv_assist_media_player', key: MP_KEY, name: 'Media Player', icon: 'mdi:television-speaker',
        supports_pause: false,
        supported_formats: [{ format: 'mp3', purpose: 0 }, { format: 'mp3', purpose: 1 }],
        feature_flags: E.MP_FEATURE.PLAY | E.MP_FEATURE.STOP | E.MP_FEATURE.PLAY_MEDIA | E.MP_FEATURE.VOLUME_SET |
          E.MP_FEATURE.VOLUME_MUTE | E.MP_FEATURE.MEDIA_ANNOUNCE });
      this.send('ListEntitiesSwitchResponse', { object_id: 'lg_tv_screen', key: SCREEN_KEY, name: T('d_entity_screen'), icon: 'mdi:television' });
      return this.send('ListEntitiesDoneResponse', {});
    case 'SubscribeStatesRequest':
    case 'SubscribeHomeAssistantStatesRequest':
      this.subscribedStates = true;
      this.send('SwitchStateResponse', screenStateMsg());
      return this.send('MediaPlayerStateResponse', playerStateMsg());
    case 'SwitchCommandRequest':
      if (m.key === SCREEN_KEY) setScreen(!!m.state, 'home assistant');
      return;
    case 'MediaPlayerCommandRequest':
      if (m.has_media_url && m.media_url) { log('media: play', m.media_url); playUrls([m.media_url], m.announcement); }
      if (m.has_volume) { player.volume = Math.max(0, Math.min(1, m.volume || 0)); setPlayerState(player.state); }
      if (m.has_command) {
        var c = E.MP_CMD[m.command || 0];
        if (c === 'STOP' || c === 'PAUSE') stopPlayback();
        else if (c === 'MUTE' || c === 'UNMUTE') { player.muted = c === 'MUTE'; setPlayerState(player.state); }
        else if (c === 'VOLUME_UP') { player.volume = Math.min(1, player.volume + 0.1); setPlayerState(player.state); }
        else if (c === 'VOLUME_DOWN') { player.volume = Math.max(0, player.volume - 0.1); setPlayerState(player.state); }
      }
      return;
    case 'SubscribeVoiceAssistantRequest':
      if (m.subscribe) { va = this; log('api: voice assistant subscribed by', this.name, '(flags ' + (m.flags || 0) + ')'); setHa(this); scheduleListening(1000); }
      else if (va === this) { va = null; setHa(null); }
      return;
    case 'VoiceAssistantConfigurationRequest':
      return this.send('VoiceAssistantConfigurationResponse', { available_wake_words: [], active_wake_words: [], max_active_wake_words: 0 });
    case 'NoiseEncryptionSetKeyRequest': return onSetKey(this, m);
    case 'VoiceAssistantResponse': return onVaResponse(this, m);
    case 'VoiceAssistantEventResponse': return onVaEvent(this, m);
    case 'VoiceAssistantAnnounceRequest': return onAnnounce(this, m);
    case 'VoiceAssistantTimerEventResponse': return onTimer(m);
    default: return;   // logs, services, time, set configuration: ignore
  }
};
Client.prototype.closed = function () {
  clients = clients.filter(function (c) { return c !== this; }, this);
  if (va === this) { va = null; setHa(null); endSession('ha disconnected', true); }
};

function setHa(c) {
  status.ha = c ? c.name + ' @ ' + c.sock.remoteAddress : null;
  status.haSince = c ? new Date().toISOString() : null;
  saveStatus();
}

function broadcast(type, obj) { clients.forEach(function (c) { if (c.subscribedStates) c.send(type, obj); }); }

var server = net.createServer(function (sock) {
  var c = new Client(sock);
  sock.setNoDelay(true);
  log('api: connection from', sock.remoteAddress);
  if (encrypted()) attachNoise(c, API_KEY);
  sock.on('data', function (d) {
    try { c.onData(d); } catch (e) { log('api: error from', sock.remoteAddress + ':', e.stack || e); sock.destroy(); }
  });
  sock.on('error', function () {});
  sock.on('close', function () { clearTimeout(c.hsTimer); log('api: closed', sock.remoteAddress); c.closed(); });
});
server.on('error', function (e) { log('api server error', e.message); process.exit(1); });
// The entity name is translated, so learn the TV language before Home Assistant can list entities:
// listen on the first answer from the settings service, at once if the language is already known
// from the settings, and after 2 s at the latest.
var listenStarted = false;
function listen() {
  if (listenStarted) return;
  listenStarted = true;
  server.listen(CFG.port, '0.0.0.0', function () { log('api: listening on', CFG.port); });
}
watchLocale(listen);
if (CFG.lang || CFG.tv_locale) listen(); else setTimeout(listen, 2000);

// ------------------------------------------------------------------ USB microphone (hands-free)
// A USB microphone shows up in LG's PulseAudio as alsa_input.usb-*. We read it with parec (16 kHz mono)
// and let Home Assistant detect the wake word (pipeline wake word stage, e.g. openWakeWord).
var usb = { source: null, configured: null, checking: false };
var PA = ['-s', 'unix:/var/run/pulse/native'];

function checkUsbMic() {
  if (usb.checking) return;
  usb.checking = true;
  var out = '', p = spawnClean('pactl', PA.concat(['list', 'sources', 'short']));
  p.stdout.on('data', function (d) { out += d; });
  p.on('error', function () { usb.checking = false; });
  p.on('close', function () {
    usb.checking = false;
    var src = null;
    out.split('\n').forEach(function (l) {
      var name = l.split('\t')[1];
      if (name && /^alsa_input\.usb-/.test(name) && !/\.monitor$/.test(name) && !src) src = name;
    });
    if (src !== usb.source) {
      log('usb mic:', src || 'none');
      usb.source = src;
      status.usbMic = src; saveStatus();
      if (src) configureUsbMic(src);
      else if (session && session.type === 'wake') abortSession('usb mic removed');
    }
    ensureListening();
  });
}

function configureUsbMic(src) {
  // software volume 100 %, hardware capture gain on every USB card (default ~19 dB is too quiet for a room)
  spawnClean('pactl', PA.concat(['set-source-volume', src, '100%']), { stdio: 'ignore' }).on('error', function () {});
  try {
    fs.readFileSync('/proc/asound/cards', 'utf8').split('\n').forEach(function (l) {
      var m = /^\s*(\d+)\s+\[.*\]:\s*USB-Audio/.exec(l);
      if (m) spawnClean('amixer', ['-q', '-c', m[1], 'sset', 'Mic', 'capture', (CFG.mic_gain || 85) + '%', 'cap'], { stdio: 'ignore' }).on('error', function () {});
    });
  } catch (e) {}
  usb.configured = src;
}

function UsbMic(src, onData) {
  this.closed = false;
  var self0 = this;
  if (ear && ear.src === src) {          // the ear already records this microphone: share its stream
    this.proc = null;
    this.listener = function (pcm) { if (!self0.closed) onData(pcm); };
    ear.listeners.push(this.listener);
    return;
  }
  var p = this.proc = spawnClean('parec', PA.concat(['-d', src, '--rate=16000', '--channels=1', '--format=s16le', '--latency-msec=40']));
  var self = this;
  p.stdout.on('data', function (pcm) { if (!self.closed) onData(pcm); });
  p.on('error', function () {});
  p.on('exit', function () { if (!self.closed) { log('usb mic: parec exited'); usb.source = null; } });
}
UsbMic.prototype.close = function () {
  this.closed = true;
  if (this.proc) { try { this.proc.kill(); } catch (e) {} }
  else if (ear) ear.listeners = ear.listeners.filter(function (l) { return l !== this.listener; }, this);
};

// ------------------------------------------------------------------ wake word on the TV (microWakeWord)
// With a detector binary (bin/mww, built by native/build.sh) and a model (models/*.json + .tflite) the TV
// listens for the wake word itself: one parec process (the "ear") feeds the detector all the time and,
// during a conversation, Home Assistant as well, so nothing said right after the wake word is lost. No audio
// leaves the TV until the wake word is heard. Without the binary, or with CFG.wake_word === 'ha', the
// microphone is streamed to Home Assistant, which then detects the wake word (the 'wake' session below).
var MWW_BIN = process.env.LGTV_ASSIST_MWW || path.join(__dirname, 'bin', 'mww');
var MODELS_DIR = process.env.LGTV_ASSIST_MODELS || path.join(__dirname, 'models');
var DEFAULT_WAKE = 'okay_nabu';
var ear = null;                      // { src, parec, mww, model, listeners: [fn(pcm)] }
var wake = { models: [], failures: [], broken: false };

function loadWakeModels() {
  var list = [];
  try {
    fs.readdirSync(MODELS_DIR).sort().forEach(function (f) {
      if (!/\.json$/.test(f)) return;
      var c = readJson(path.join(MODELS_DIR, f), null), m = c && c.micro;
      if (!c || c.type !== 'micro' || !m || !(m.probability_cutoff > 0) || !(m.sliding_window_size >= 1)) return;
      var file = path.join(MODELS_DIR, String(c.model || ''));
      if (!fs.existsSync(file)) return;
      list.push({ id: f.replace(/\.json$/, ''), word: String(c.wake_word || f), file: file,
        cutoff: m.probability_cutoff, window: m.sliding_window_size, languages: c.trained_languages || [] });
    });
  } catch (e) {}
  if (!fs.existsSync(MWW_BIN)) list = [];
  return list;
}
wake.models = loadWakeModels();
function wakeModel() {
  if (CFG.wake_word === 'ha' || wake.broken || !wake.models.length) return null;
  var want = CFG.wake_word || DEFAULT_WAKE;
  return wake.models.filter(function (m) { return m.id === want; })[0] ||
    wake.models.filter(function (m) { return m.id === DEFAULT_WAKE; })[0] || wake.models[0];
}
function wakeStatus() {
  var m = wakeModel();
  status.wake = m ? { on: 'tv', id: m.id, word: m.word } : { on: 'ha' };
  status.wakeModels = wake.models.map(function (x) { return { id: x.id, word: x.word }; });
  saveStatus();
}
wakeStatus();
log('wake word:', wakeModel() ? wakeModel().word + ' (detected on the TV)' : 'detected by Home Assistant' +
  (wake.models.length ? '' : ' (no detector in this build)'));

// The microphone or the detector ended without being asked to. Seen on the TV: both children of the daemon
// get SIGABRT a few ms after they were started when Home Assistant connects at that very moment (cause
// unknown; started a second later they run fine). So: start again shortly; a microphone that is gone is
// noticed by checkUsbMic. A detector that refuses its model, or keeps dying, makes Home Assistant detect the
// wake word instead, so the TV never ends up deaf.
function earFailed(why) {
  stopEar();
  var now = Date.now();
  wake.failures = wake.failures.filter(function (t) { return now - t < 60000; }).concat([now]);
  if (why === 'refused' || wake.failures.length >= 5) {
    wake.broken = true;
    log('wake word: giving up on the detector; Home Assistant detects the wake word');
    wakeStatus();
  }
  scheduleListening(1000);
}

function stopEar() {
  if (!ear) return;
  var e = ear; ear = null;
  try { e.parec.kill(); } catch (x) {}
  try { e.mww.kill(); } catch (x) {}
}
function startEar(src, model) {
  if (ear && ear.src === src && ear.model === model) return;
  stopEar();
  var e = ear = { src: src, model: model, listeners: [], parec: null, mww: null };
  e.mww = spawnClean(MWW_BIN, [model.file, String(model.cutoff), String(model.window)], { stdio: ['pipe', 'pipe', 'pipe'] });
  var errTail = '';
  e.mww.stderr.on('data', function (d) { errTail = (errTail + d).slice(-400); });
  e.mww.on('error', function () {});
  e.mww.stdin.on('error', function () {});
  var out = '';
  e.mww.stdout.on('data', function (d) {
    out += d;
    var i;
    while ((i = out.indexOf('\n')) >= 0) {
      var p = out.slice(0, i).split(' '); out = out.slice(i + 1);
      if (p[0] === 'wake' && ear === e) onLocalWake(model, parseFloat(p[2]));
    }
  });
  // 'close', not 'exit': the error output must be read to the end first
  e.mww.on('close', function (code, sig) {
    if (ear !== e) { if (sig !== 'SIGTERM') log('wake word: old detector ended (' + (sig || code) + ')' + (errTail ? ': ' + errTail.trim() : '')); return; }
    log('wake word: detector stopped (' + (sig || code) + ')' + (errTail ? ': ' + errTail.trim().split('\n').slice(-2).join(' | ') : ''));
    earFailed(code === 2 || code === 3 ? 'refused' : 'stopped');
  });
  e.parec = spawnClean('parec', PA.concat(['-d', src, '--rate=16000', '--channels=1', '--format=s16le', '--latency-msec=40']));
  e.parec.stdout.on('data', function (pcm) {
    if (ear !== e) return;
    if (e.mww.stdin.writable) e.mww.stdin.write(pcm);
    for (var i = 0; i < e.listeners.length; i++) e.listeners[i](pcm);
  });
  e.parec.on('error', function () {});
  var parecErr = '';
  e.parec.stderr.on('data', function (d) { parecErr = (parecErr + d).slice(-300); });
  e.parec.on('close', function (code, sig) {
    if (ear !== e) return;
    log('usb mic: parec exited (' + (sig || code) + ')' + (parecErr ? ': ' + parecErr.trim() : ''));
    earFailed('parec');
  });
  log('wake word: listening for', model.word, 'on the TV');
}

// The detector heard the wake word: what Home Assistant's WAKE_WORD_END does in the other mode, then a
// conversation that starts at speech-to-text.
function onLocalWake(model, prob) {
  if (session || player.proc) { log('wake word:', model.word, '(ignored: busy)'); return; }
  log('wake word:', model.word, isNaN(prob) ? '' : prob.toFixed(2));
  if (!va) { toast(T('d_no_ha')); return; }
  duckTv();
  if (CFG.wake_screen !== false && screen.on === false) setScreen(true, 'wake word');
  toast(T('d_listening'), 'listen');
  startSession({ type: 'vad', wake_word_phrase: model.word });
}

// ------------------------------------------------------------------ TV volume ducking
var duck = { saved: null };
function getTvVolume(cb) {
  if (!handles) return cb(null);
  var c = handles[0].call('luna://com.webos.service.audio/master/getVolume', '{}');
  c.addListener('response', function (m) {
    var r = {}; try { r = JSON.parse(m.payload()); } catch (e) {}
    cb(r.volumeStatus && typeof r.volumeStatus.volume === 'number' ? r.volumeStatus.volume : (typeof r.volume === 'number' ? r.volume : null));
  });
}
function duckTv() {
  if (CFG.duck === false || duck.saved !== null) return;
  getTvVolume(function (v) {
    var target = CFG.duck_volume === undefined ? 5 : CFG.duck_volume;
    if (v === null || v <= target) return;
    duck.saved = v;
    lunaSend('luna://com.webos.service.audio/master/setVolume', { volume: target });
  });
}
function restoreTv() {
  if (duck.saved === null) return;
  lunaSend('luna://com.webos.service.audio/master/setVolume', { volume: duck.saved });
  duck.saved = null;
}

// ------------------------------------------------------------------ screen (switch entity "Ekran")
// "Screen off" keeps the TV running (mic, hands-free listening, audio replies) with the panel dark.
// Real standby (power button, Quick Start+) suspends the whole system, so nothing can listen then.
var SCREEN_KEY = 0x5343524e;   // 'SCRN'
var screen = { state: null, on: null, sub: null };
function screenIsOn(st) { return !!st && !/screen off|standby|suspend|power off/i.test(st); }
// tvpower only answers luna-send (our palmbus handles get "Not permitted"): keep a luna-send -i subscription
function watchScreen() {
  if (screen.sub) return;
  var p = screen.sub = spawnClean('luna-send', ['-i', 'luna://com.webos.service.tvpower/power/getPowerState', '{"subscribe":true}']);
  var buf = '';
  p.stdout.on('data', function (d) {
    buf += d;
    var i;
    while ((i = buf.indexOf('}')) >= 0) {           // one flat JSON object per response
      var chunk = buf.slice(0, i + 1); buf = buf.slice(i + 1);
      var j = chunk.lastIndexOf('{'); if (j < 0) continue;
      var r = {}; try { r = JSON.parse(chunk.slice(j)); } catch (e) { continue; }
      if (!r.state) continue;
      var on = screenIsOn(r.state);
      if (r.state !== screen.state) log('screen:', r.state + (r.processing ? ' (' + r.processing + ')' : ''));
      screen.state = r.state;
      if (on !== screen.on) { screen.on = on; status.screen = r.state; saveStatus(); broadcast('SwitchStateResponse', screenStateMsg()); }
    }
  });
  p.on('error', function () {});
  p.on('exit', function () { screen.sub = null; setTimeout(watchScreen, 5000); });
}
function screenStateMsg() { return { key: SCREEN_KEY, state: !!screen.on, missing_state: screen.on === null }; }
function setScreen(on, why) {
  log('screen:', on ? 'turn on' : 'turn off', '(' + why + ')');
  lunaSend('luna://com.webos.service.tvpower/power/' + (on ? 'turnOnScreen' : 'turnOffScreen'), {});
}

// ------------------------------------------------------------------ voice session
// types: 'ptt'  - Magic Remote mic while the button is held (end = button release)
//        'vad'  - follow-up without a button (continue_conversation / start_conversation); HA's VAD ends it
//        'wake' - hands-free: USB mic streamed continuously, HA detects the wake word, then STT with VAD
var session = null, listenTimer = null, listenBackoff = 0;

function startSession(opts) {
  if (session) return;
  if (!va) { if (opts.type !== 'wake') toast(T('d_no_ha')); return; }
  var type = opts.type || 'ptt';
  var s = session = { type: type, ptt: type === 'ptt', started: false, audioEnded: false, buf: [], bytes: 0, t0: Date.now(),
    client: va, woke: false };
  if (type !== 'wake') { status.lastSession = new Date().toISOString(); saveStatus(); stopPlayback(true); }
  if (type !== 'wake') s.maxTimer = setTimeout(function () { finishAudio('max length'); }, CFG.max_seconds * 1000);
  s.flags = type === 'ptt' ? 0 : type === 'wake' ? (E.VA_REQUEST_FLAG.USE_WAKE_WORD | E.VA_REQUEST_FLAG.USE_VAD) : E.VA_REQUEST_FLAG.USE_VAD;
  s.conversationId = opts.conversation_id || '';
  s.wakeWordPhrase = opts.wake_word_phrase || '';
  // While an aborted run is still winding down, hold the request (the mic already buffers audio).
  if (staleUntil && Date.now() < staleUntil) { s.deferred = true; clearTimeout(staleTimer); staleTimer = setTimeout(staleClear, staleUntil - Date.now()); }
  else sendStart(s);
  var onData = function (pcm) { onMicData(s, pcm); };
  if (type === 'ptt' || !usb.source) {
    s.mic = new Mic(onData, null, function (why) {
      if (type === 'ptt') toast(T('d_mic_unavailable'));
      else if (type === 'vad') toast(T('d_press_to_answer'));
      abortSession('mic: ' + why);
    });
  } else {
    s.mic = new UsbMic(usb.source, onData);
  }
  status.listening = type === 'wake' || !!ear; saveStatus();
}

function onMicData(s, pcm) {
  if (s.audioEnded) return;
  s.bytes += pcm.length;
  if (!s.started) { if (s.type !== 'wake' || s.buf.length < 50) s.buf.push(pcm); return; }
  sendAudio(s, pcm);
}
function sendAudio(s, pcm) {
  for (var o = 0; o < pcm.length; o += 2048) s.client.send('VoiceAssistantAudio', { data: pcm.slice(o, o + 2048) });
}

function onVaResponse(client, m) {
  var s = session;
  if (!s || client !== s.client) return;
  if (m.error) {
    log('va: HA could not start the pipeline');
    if (s.type !== 'wake') toast(T('d_assist_unavailable'));
    listenBackoff = Date.now() + 30000;
    return abortSession('ha error');
  }
  s.started = true;   // port 0 = audio over the API connection
  while (s.buf.length) sendAudio(s, s.buf.shift());
  if (s.audioEnded) s.client.send('VoiceAssistantAudio', { end: true });
}

function finishAudio(why) {
  var s = session;
  if (!s || s.audioEnded) return;
  clearTimeout(s.maxTimer);
  // let the socket flush the tail of the utterance
  setTimeout(function () {
    if (s.audioEnded) return;
    s.audioEnded = true;
    s.mic.close();
    log('va: audio end (' + why + '),', (s.bytes / 32000).toFixed(1), 's');
    if (s.ptt && s.bytes < 8000) { toast(T('d_hold_and_speak')); return abortSession('too short'); }
    if (s.started) s.client.send('VoiceAssistantAudio', { end: true });
  }, s.ptt ? 250 : 0);
}

// After we abort a run, HA still sends that run's last events (ERROR/RUN_END). They must not be taken
// for events of the session that replaced it (e.g. the remote button aborting hands-free listening).
var staleUntil = 0, staleTimer = null;

function sendStart(s) {
  s.deferred = false;
  s.client.send('VoiceAssistantRequest', { start: true, flags: s.flags, conversation_id: s.conversationId || '', wake_word_phrase: s.wakeWordPhrase || '' });
}
function staleClear() {
  staleUntil = 0; clearTimeout(staleTimer);
  if (session && session.deferred && !session.client.sock.destroyed) sendStart(session);
}

function abortSession(why) {
  var s = session;
  if (!s) return;
  clearTimeout(s.maxTimer);
  if (!s.audioEnded) { s.audioEnded = true; s.mic.close(); }
  if (s.client && !s.client.sock.destroyed) {
    s.client.send('VoiceAssistantRequest', { start: false });
    staleUntil = Date.now() + 1000;
  }
  endSession(why);
}

function endSession(why) {
  var s = session;
  if (!s) return;
  clearTimeout(s.maxTimer);
  if (!s.audioEnded) { s.audioEnded = true; s.mic.close(); }
  session = null;
  status.listening = !!ear; saveStatus();
  if (s.type !== 'wake' || s.woke || why !== 'run end') log('va: session end:', why);
  if (!player.proc) restoreTv();
  scheduleListening(why === 'run end' ? 300 : 1500);
}

// (Re)start the hands-free wake word session whenever nothing else is going on.
function ensureListening() {
  var model = CFG.hands_free !== false && usb.source ? wakeModel() : null;
  if (model) {                           // the TV detects the wake word itself
    if (!va && !ear) return;             // nothing to do with it before Home Assistant is there
    if (session && session.type === 'wake') abortSession('wake word moved to the TV');
    startEar(usb.source, model);
    if (!status.listening && !session) { status.listening = true; saveStatus(); }
    return;
  }
  stopEar();
  if (status.listening && !session) { status.listening = false; saveStatus(); }
  if (CFG.hands_free === false || !usb.source || !va || session || player.proc || !handles) return;
  if (Date.now() < listenBackoff) return scheduleListening(listenBackoff - Date.now());
  restoreTv();
  startSession({ type: 'wake' });
}
function scheduleListening(ms) {
  clearTimeout(listenTimer);
  listenTimer = setTimeout(ensureListening, ms || 300);
}

function evData(m) { var d = {}; (m.data || []).forEach(function (x) { d[x.name] = x.value; }); return d; }

function onVaEvent(client, m) {
  // proto3 omits default values: an absent event_type is 0 (ERROR)
  var type = E.VA_EVENT[m.event_type || 0], d = evData(m), s = session;
  var quiet = s && s.type === 'wake' && !s.woke && /^(RUN_START|WAKE_WORD_START)$/.test(type);
  if (staleUntil) {
    if (Date.now() > staleUntil) staleClear();
    else {
      if (type === 'RUN_END') staleClear();       // the aborted run is over
      return;                                      // a new session's request isn't sent yet, so this is old
    }
  }
  if (type !== 'INTENT_PROGRESS' && !quiet) log('va event', type, JSON.stringify(d).slice(0, 200));
  if (!s || client !== s.client) return;
  switch (type) {
    case 'WAKE_WORD_END':
      s.woke = true;
      s.bytes = 0;
      status.lastSession = new Date().toISOString(); saveStatus();
      s.maxTimer = setTimeout(function () { finishAudio('max length'); }, CFG.max_seconds * 1000);
      stopPlayback(true);
      duckTv();
      if (CFG.wake_screen !== false && screen.on === false) setScreen(true, 'wake word');
      toast(T('d_listening'), 'listen');
      break;
    case 'STT_VAD_END': if (!s.ptt) finishAudio('vad'); break;
    case 'STT_END':
      if (!s.audioEnded) finishAudio('stt end');
      status.lastText = d.text; saveStatus();
      if (d.text) toast('🎤 ' + d.text);
      break;
    case 'INTENT_END':
      s.continueConversation = d.continue_conversation === '1';
      s.conversationId = d.conversation_id || s.conversationId;
      break;
    case 'TTS_START':
      // LLM/conversation agent errors come back as English error dumps: show a short note, don't speak them
      if (d.text && /problem getting a response|RESOURCE_EXHAUSTED|Unable to get response/.test(d.text)) {
        s.muteTts = true;
        d.text = T('ai_unavailable');
      }
      status.lastReply = d.text; saveStatus();
      if (d.text) toast(d.text);
      break;
    case 'TTS_END':
      if (d.url && s.muteTts) { scheduleListening(300); break; }
      if (d.url) {
        var cont = s.continueConversation, conv = s.conversationId;
        restoreTv();
        playUrls([d.url], true, function (ok) {
          if (ok && cont) startSession({ type: 'vad', conversation_id: conv });
          else scheduleListening(300);
        });
      }
      break;
    case 'ERROR':
      status.lastError = (d.code || '') + ' ' + (d.message || ''); saveStatus();
      if (s.type === 'wake' && !s.woke) { log('va: wake word stage error', d.code); listenBackoff = Date.now() + 10000; break; }
      toast(d.code === 'stt-no-text-recognized' ? T('d_not_heard') : T('d_assistant_error', { msg: d.message || d.code }));
      break;
    case 'RUN_END':
      endSession('run end');
      break;
  }
}

function onAnnounce(client, m) {
  log('announce:', m.text || '', m.media_id);
  if (m.text) toast('📢 ' + m.text);
  if (session && session.type === 'wake' && !session.woke) abortSession('announcement');
  playUrls([m.preannounce_media_id, m.media_id], true, function (ok) {
    client.send('VoiceAssistantAnnounceFinished', { success: ok });
    if (ok && m.start_conversation) startSession({ type: 'vad' });
    else scheduleListening(300);
  });
}

function onTimer(m) {
  var t = E.TIMER_EVENT[m.event_type || 0];          // absent = 0 (STARTED)
  log('timer', t, m.name || '', m.seconds_left);
  var min = Math.round((m.total_seconds || 0) / 60);
  if (t === 'FINISHED') toast(m.name ? T('d_timer_done_named', { name: m.name }) : T('d_timer_done'));
  else if (t === 'STARTED') toast(m.name ? T('d_timer_started_named', { name: m.name, min: min }) : T('d_timer_started', { min: min }));
}

// ------------------------------------------------------------------ push-to-talk
function pttDown() {
  log('key: mic down');
  if (session && session.type === 'wake' && !session.woke) {
    abortSession('ptt');               // the remote wins over hands-free listening
    clearTimeout(listenTimer);
  }
  if (session) return;
  startSession({ type: 'ptt' });
}
function pttUp() {
  log('key: mic up');
  if (session && session.ptt) finishAudio('key up');
}

// Live settings: toasts / hands_free / wake_screen / duck / mic_gain / language apply without a restart
// (the service restarts the daemon only when the name or port changes).
var SETTINGS = path.join(DATA_DIR, 'settings.json');
fs.watchFile(SETTINGS, { interval: 1000 }, function () {
  var next = readJson(SETTINGS, {});
  ['toasts', 'hands_free', 'wake_screen', 'duck', 'duck_volume', 'mic_gain', 'max_seconds', 'tv_locale', 'wake_word'].forEach(function (k) {
    if (next[k] !== undefined && next[k] !== CFG[k]) { log('settings:', k, '=', JSON.stringify(next[k])); CFG[k] = next[k]; }
  });
  // "lang" is removed from the file when the user goes back to automatic, so compare it as it is
  // (but not when the file could not be read at all, e.g. while it is being written)
  if (Object.keys(next).length && next.lang !== CFG.lang) { CFG.lang = next.lang; log('settings: lang =', next.lang || 'auto', '->', lang()); }
  if (usb.source && next.mic_gain !== undefined) configureUsbMic(usb.source);
  wake.broken = false; wake.failures = []; wakeStatus();
  if (CFG.hands_free === false || !wakeModel()) { stopEar(); if (!session) { status.listening = false; saveStatus(); } }
  if (CFG.hands_free === false && session && session.type === 'wake' && !session.woke) abortSession('hands-free off');
  else scheduleListening(300);
});

checkUsbMic();
setInterval(checkUsbMic, 15000);
watchScreen();

// ------------------------------------------------------------------ mDNS
var TXT = { friendly_name: CFG.friendly_name, version: '2025.9.0', mac: MAC.replace(/:/g, '').toLowerCase(),
  platform: 'HOST', board: 'lg-webos', network: NET.ifname.indexOf('wlan') === 0 ? 'wifi' : 'ethernet',
  project_name: 'lgtv-assist.LG TV Assist', project_version: VERSION };
encTxt(TXT);
var mdns = new Mdns({ instance: CFG.name, host: CFG.name, ip: NET.ip, port: CFG.port, txt: TXT });
mdns.start(log);

function shutdown() {
  log('shutting down');
  try { if (fs.readFileSync(NOSPY_CLAIM, 'utf8').split(' ')[0] === String(process.pid)) fs.unlinkSync(NOSPY_CLAIM); } catch (e) {}
  mdns.stop();
  if (session) abortSession('shutdown');
  stopEar();
  stopPlayback(true);
  setTimeout(function () { process.exit(0); }, 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', function (e) { log('uncaught', e && e.stack || e); });
setInterval(function () { return handles; }, 1 << 30);
