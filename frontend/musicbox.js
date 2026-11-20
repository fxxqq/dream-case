/* 造梦橱窗 · 八音盒（2026-11-18）
 * ---------------------------------------------------------------
 * 为什么单独一个文件：曲库 + 合成 + 生成器有几百行，塞进 index.html 会把那段
 * 形象脚本冲淡；/mascots 页以后也可能要用。挂在 window.MusicBox 上，谁都能调。
 *
 * 三条底线：
 *   1) 不加载任何音频文件、不发任何请求 —— 全是 WebAudio 现算，体积几乎为零；
 *   2) 同一时刻只有一个 ctx：再点就是停，不是再叠一层（旧版连点会同时放两遍）；
 *   3) 曲目全部是原创或公有领域，不碰现代在版作品（扒谱复刻 = 侵权）。
 *
 * 用法：
 *   MusicBox.play('cradle')           放指定一首
 *   MusicBox.random()                 随机一首（避开上一首）
 *   MusicBox.generate({mood:'night', bpm:84, density:'mid', bars:16, seed:'ABC123'})
 *   MusicBox.playSeed('ABC123')       拿别人的种子放同一首
 *   MusicBox.stop() / .state()
 * 状态变化会调 MusicBox.onChange(state)，面板那边照着改按钮文案。
 */
(function(){
  'use strict';
  if (window.MusicBox) return;

  /* ---------------- 音高 ---------------- */
  var SEMI = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  function midi(n){
    var m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
    if (!m) return 72;
    var v = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return v + (parseInt(m[3], 10) + 1) * 12;
  }
  function hz(m){ return 440 * Math.pow(2, (m - 69) / 12); }
  // 高音收得快、低音留得久，八音盒的金属齿就是这个脾气
  function ringOf(m){
    if (m < 55) return 1.6;
    return Math.max(1.0, Math.min(2.7, 2.7 - (m - 60) * 0.045));
  }

  /* ---------------- 合成：拨片泛音 ----------------
     5 个分音，2.001 / 3.003 / 4.180 / 6.640 是故意不准的整数倍：
     真正的八音盒齿片不是理想弦，泛音本来就偏，准了反而像电子琴。 */
  var PARTIALS = [
    { r:1.000, g:1.000, k:1.00 },
    { r:2.001, g:0.460, k:0.78 },
    { r:3.003, g:0.230, k:0.62 },
    { r:4.180, g:0.110, k:0.48 },
    { r:6.640, g:0.045, k:0.34 }
  ];
  function strike(ctx, out, m, t, ring, amp, np){
    var f = hz(m), n = np || PARTIALS.length;
    for (var i = 0; i < n; i++){
      var p = PARTIALS[i];
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * p.r, t);
      var peak = Math.max(0.0002, amp * p.g * 0.22);
      var tail = t + ring * p.k;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, tail);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(tail + 0.05);
    }
  }

  /* ---------------- 曲式 → 事件 ---------------- */
  function buildBars(v){
    var ev = [], beats = 0;
    for (var i = 0; i < v.bars.length; i++){
      var bar = v.bars[i], b = 0;
      for (var j = 0; j < bar.length; j++){
        var tok = bar[j], cut = tok.indexOf(':');
        var n = cut < 0 ? tok : tok.slice(0, cut);
        var d = cut < 0 ? 1 : parseFloat(tok.slice(cut + 1));
        if (n !== 'r'){
          var m = midi(n);
          ev.push({ m: m, b: beats + b, ring: ringOf(m), amp: 0.95 });
        }
        b += d;
      }
      if (v.bass && v.bass[i]){
        var bm = midi(v.bass[i]);
        ev.push({ m: bm, b: beats, ring: ringOf(bm), amp: 0.42 });
      }
      beats += v.beatsPerBar;
    }
    return { ev: ev, beats: beats };
  }

  /* 和弦 + 分解铺底：生成器与长曲共用。琶音自动生成，旋律照旧手写/生成 */
  var CH = {
    Em9:  ['E3','B3','F#4','G4'],
    Cmaj7:['C3','G3','E4','B4'],
    G:    ['G3','D4','B4','D5'],
    Dadd9:['D3','A3','E4','F#4'],
    Am7:  ['A3','E4','G4','C5'],
    Bm7:  ['B3','F#4','A4','D5'],
    Fmaj7:['F3','C4','A4','E5'],
    Dm7:  ['D3','A3','F4','C5'],
    G6:   ['G3','D4','B4','E5'],
    Em7:  ['E3','B3','D4','G4'],
    Am9:  ['A3','E4','G4','B4'],
    Cadd9:['C3','G3','D4','E4']
  };
  var ARP = [0,1,2,3,2,1,2,3];   // 每小节 8 个八分音符，上行再回落

  function buildChords(v){
    var ev = [], bpb = 4;
    for (var i = 0; i < v.chords.length; i++){
      var ch = CH[v.chords[i]].map(midi);
      for (var k = 0; k < ARP.length; k++){
        var a = ch[ARP[k]];
        ev.push({ m:a, b:i*bpb + k*0.5, ring:ringOf(a)*0.6, amp:0.26, np:3 });
      }
      ev.push({ m:ch[0], b:i*bpb, ring:ringOf(ch[0]), amp:0.34, np:4 });

      var bar = v.melody[i] || [], b = 0;
      for (var j = 0; j < bar.length; j++){
        var tok = bar[j], cut = tok.indexOf(':');
        var n = cut < 0 ? tok : tok.slice(0, cut);
        var d = cut < 0 ? 1 : parseFloat(tok.slice(cut + 1));
        if (n !== 'r'){
          var m = midi(n);
          ev.push({ m:m, b:i*bpb + b, ring:ringOf(m), amp:0.95, np:5 });
        }
        b += d;
      }
    }
    ev.sort(function(x, y){ return x.b - y.b; });
    return { ev:ev, beats:v.chords.length * bpb };
  }

  function buildTrack(v){
    if (v.events) return { ev: v.events, beats: v.beats };   // 作曲页：音符已经摆好，直接用
    if (v.gen) return v.gen();
    if (v.chords) return buildChords(v);
    return buildBars(v);
  }

  /* ---------------- 生成器：同种子必然同一首 ---------------- */
  function hashStr(s){
    var h = 2166136261;
    for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a){
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var PC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function noteName(m){ return PC[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

  var MOODS = {
    night: { label:'夜航', tonic:64, scale:[0,2,3,5,7,8,10],
      progs:[['Em9','Cmaj7','G','Dadd9'],['Em9','Am7','Cmaj7','Bm7'],['Cmaj7','G','Am7','Bm7'],['Em9','Cmaj7','Am7','Dadd9']] },
    day:   { label:'晴日', tonic:60, scale:[0,2,4,5,7,9,11],
      progs:[['Cmaj7','Am7','Fmaj7','G6'],['Cmaj7','Fmaj7','G6','Am7'],['Fmaj7','G6','Em7','Am7'],['Cmaj7','Em7','Fmaj7','G6']] },
    mist:  { label:'雾',   tonic:62, scale:[0,2,3,5,7,9,10],
      progs:[['Dm7','G6','Cmaj7','Am9'],['Cmaj7','Am9','Dm7','G6'],['Dm7','Cmaj7','G6','Am9']] },
    old:   { label:'古意', tonic:60, scale:[0,2,4,7,9],
      progs:[['Cadd9','Fmaj7','G6','Am7'],['Cadd9','Am7','Fmaj7','G6'],['Fmaj7','G6','Cadd9','Am7']] }
  };

  var RHYTHM = {
    thin:  [[1,1,2],[2,2],[3,1],[2,1,1]],
    mid:   [[1,1,1,1],[1,1,2],[2,1,1],[3,1],[0.5,0.5,1,2]],
    thick: [[0.5,0.5,1,1,1],[1,1,1,0.5,0.5],[0.5,0.5,0.5,0.5,1,1],[1,0.5,0.5,1,1]]
  };

  var TITLE_A = ['微光','雾中','候鸟','晚风','旧梦','潮声','空屋','枯枝','水影','归途','长夜','雪线','远岸','晒台','信纸'];
  var TITLE_B = ['的信','的窗','的桥','的河','的岛','的灯','的坡','的话','的路'];

  function pickOne(rng, arr){ return arr[Math.floor(rng() * arr.length)]; }

  function nearestIdx(pool, from, targets){
    var best = from, bd = 1e9;
    for (var i = 0; i < pool.length; i++){
      for (var j = 0; j < targets.length; j++){
        var d = Math.abs(pool[i] - targets[j]) + Math.abs(i - from) * 0.8;
        if (d < bd){ bd = d; best = i; }
      }
    }
    return best;
  }

  /* 旋律不是随机音：调式音阶里走，76% 级进，每 4 小节一句、句末落主音/五音，
     整体按「低 → 中 → 高 → 回落」四段走弧线，所以有起有收。 */
  function buildMelody(rng, mood, nbars, density){
    var pool = [], i, o;
    for (o = 0; o < 3; o++){
      for (i = 0; i < mood.scale.length; i++){
        var mm = mood.tonic + mood.scale[i] + o * 12;
        if (mm >= 55 && mm <= 84) pool.push(mm);
      }
    }
    var idx = Math.floor(pool.length * 0.42);
    var cells = RHYTHM[density] || RHYTHM.mid;
    var out = [], prev = null, same = 0;

    for (var b = 0; b < nbars; b++){
      var pos = b % 4;
      var cell = (b === 0) ? [2, 2] : (pos === 3 ? [2, 2] : pickOne(rng, cells));
      var sec = Math.floor(b / 4) % 4;
      var aim = Math.floor(pool.length * (sec === 0 ? 0.32 : sec === 1 ? 0.48 : sec === 2 ? 0.66 : 0.44));
      var bar = [];

      for (var k = 0; k < cell.length; k++){
        var d = cell[k], last = (k === cell.length - 1);
        if (pos === 3 && last){
          idx = nearestIdx(pool, idx, [mood.tonic, mood.tonic + 7, mood.tonic + 12]);
        } else {
          var step = rng() < 0.76 ? (rng() < 0.5 ? -1 : 1) : (rng() < 0.5 ? -2 : 2);
          if (rng() < 0.2) step = (aim > idx ? 1 : -1) * (1 + Math.round(rng()));
          idx += step;
        }
        idx = Math.max(2, Math.min(pool.length - 3, idx));
        if (prev === pool[idx] && same >= 1) idx = Math.max(2, Math.min(pool.length - 3, idx + (idx > aim ? -1 : 1)));
        var m = pool[idx];
        same = (m === prev) ? same + 1 : 0;
        prev = m;
        if (!(pos === 3 && last) && d >= 1 && rng() < 0.1) bar.push('r:' + d);
        else bar.push(noteName(m) + ':' + d);
      }
      out.push(bar);
    }
    return out;
  }

  function makeSeed(){
    var s = '', cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < 6; i++) s += cs[Math.floor(Math.random() * cs.length)];
    return s;
  }

  /* 种子 = 6 位随机 + 参数四位（情绪 / 速度 / 疏密 / 长度），一共 10 位。
     为什么要把参数编进种子：种子若只有 6 位随机，同一个种子换个情绪就是另一首，
     名字却还是那个名字（名字取的是 rng 第 2、3 次的值，跟情绪无关）——
     朋友粘回来会听到「同名不同曲」，那这个分享就是坏的。
     编进去之后，种子本身就是一份完整的配方：给谁、隔多久，都是同一首。
     不足 10 位的老种子按默认参数跑，不报错。 */
  var CS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var MOOD_IDS = ['night','day','mist','old'];
  var DEN_IDS  = ['thin','mid','thick'];
  var BAR_IDS  = [12,16,24];

  function packSeed(seed, mood, bpm, density, bars){
    var mi = Math.max(0, MOOD_IDS.indexOf(mood));
    var di = Math.max(0, DEN_IDS.indexOf(density));
    var bi = Math.max(0, BAR_IDS.indexOf(Number(bars)));
    var k  = Math.max(0, Math.min(15, Math.round((Number(bpm) - 56) / 4)));
    return seed + CS[mi] + CS[k] + CS[di] + CS[bi];
  }
  function unpackSeed(seed){
    if (seed.length < 10) return null;
    var mi = CS.indexOf(seed.charAt(6)), k = CS.indexOf(seed.charAt(7));
    var di = CS.indexOf(seed.charAt(8)), bi = CS.indexOf(seed.charAt(9));
    if (mi < 0 || k < 0 || di < 0 || bi < 0) return null;
    return {
      mood: MOOD_IDS[mi] || 'night',
      bpm: 56 + k * 4,
      density: DEN_IDS[di] || 'mid',
      bars: BAR_IDS[bi] || 16
    };
  }

  function buildGenerated(opts){
    opts = opts || {};
    var seed = String(opts.seed || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    var packed = seed ? unpackSeed(seed) : null;

    // 种子说了算；没种子（或种子太短）就用界面上选的
    var moodId  = packed ? packed.mood : (MOODS[opts.mood] ? opts.mood : 'night');
    var bpm     = Number(packed ? packed.bpm : opts.bpm) || 84;
    bpm = Math.max(40, Math.min(200, bpm));
    var density = packed ? packed.density : (RHYTHM[opts.density] ? opts.density : 'mid');
    var nbars   = packed ? packed.bars
                : (BAR_IDS.indexOf(Number(opts.bars)) >= 0 ? Number(opts.bars) : 16);

    if (!packed) seed = packSeed(seed || makeSeed(), moodId, bpm, density, nbars);

    var rng = mulberry32(hashStr(seed));
    var mood = MOODS[moodId] || MOODS.night;
    var prog = pickOne(rng, mood.progs);
    var chords = [];
    for (var i = 0; i < nbars; i++) chords.push(prog[i % prog.length]);
    return {
      id: 'gen', genSeed: seed,
      name: pickOne(rng, TITLE_A) + pickOne(rng, TITLE_B),
      bpm: bpm,
      chords: chords,
      melody: buildMelody(rng, mood, nbars, density),
      moodLabel: mood.label, mood: moodId, density: density, barCount: nbars
    };
  }

  /* 星屑：五声音阶随机漫步，每次都不一样（不是种子制，是真随机） */
  var PENTA = [72,74,76,79,81,84,86,88];
  var BASSES = ['C3','A2','F2','G2','D3'];
  function buildStardust(){
    var ev = [], beats = 0, i = 4, guard = 0;
    while (beats < 36 && guard++ < 200){
      var m = PENTA[i];
      var d = [0.5,1,1,1.5,2][Math.floor(Math.random()*5)];
      ev.push({ m: m, b: beats, ring: ringOf(m), amp: 0.7 + Math.random()*0.3 });
      if (Math.random() < 0.13) ev.push({ m: m + 12, b: beats + 0.25, ring: ringOf(m+12), amp: 0.35 });
      beats += d;
      if (Math.random() < 0.34 && Math.abs(beats % 3) < 0.001){
        var bm = midi(BASSES[Math.floor(Math.random()*BASSES.length)]);
        ev.push({ m: bm, b: beats, ring: ringOf(bm), amp: 0.34 });
      }
      i += (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.3 ? 2 : 1);
      if (i < 0) i = 1;
      if (i > PENTA.length - 1) i = PENTA.length - 2;
    }
    return { ev: ev, beats: beats };
  }

  /* ---------------- 曲库 ----------------
     原创 4 首 + 经典/老歌 8 首，全部自己写或公有领域。
     别往里加在版作品：这是能公开访问、已备案的站，不是本地试试。 */
  var P = {};

  P.mindscape = {
    id:'mindscape', name:'心象风景', bpm:64, beatsPerBar:4,
    bars:[
      ['A4:2','E5','D5'], ['C5:3','B4'], ['A4:2','r:2'], ['G4','A4','C5:2'],
      ['E5:3','D5'], ['B4:2','A4','r:1'], ['D5','E5','G5:2'], ['F5:2','E5','D5'],
      ['C5:2','B4:2'], ['A4:4'], ['E5','A5','G5','E5'], ['D5:2','C5:2']
    ],
    bass:['A2','F2','C3','G2','A2','F2','D3','C3','F2','A2','G2','A2']
  };

  P.cradle = {
    id:'cradle', name:'梦的摇篮', bpm:76, beatsPerBar:3,
    bars:[
      ['E5:2','G5'], ['A5:2','G5'], ['F5','A5','C6'], ['B5:2','G5'],
      ['E5:2','G5'], ['D5','F5','A5'], ['C6:2','B5'], ['C6:3']
    ],
    bass:['C3','A2','F2','G2','C3','D3','G2','C3']
  };

  P.stardust = { id:'stardust', name:'星屑', bpm:84, gen:buildStardust };

  /* 参考 · 长曲（2026-11-19 从试听页收编）：按热门曲参数重写的那首——
     92 BPM、40 小节 ≈ 1:44，旋律是全新写的，只对齐参数。
     不进原创组（分组口径 11-18 站长定的）、不进随机池（长曲不适合「随机一首」甩出来），
     只在曲目单末尾单列一组，想听的人自己点。 */
  P.windscape2 = {
    id:'windscape2', name:'心象风景 · 92 BPM 版', bpm:92,
    chords:[
      'Em9','Cmaj7','G','Dadd9',  'Em9','Cmaj7','Am7','Bm7',
      'Em9','Cmaj7','G','Dadd9',  'Cmaj7','G','Am7','Bm7',
      'Em9','Cmaj7','G','Dadd9',  'Am7','Em9','Cmaj7','Bm7',
      'Cmaj7','G','Am7','Bm7',    'Em9','Cmaj7','G','Dadd9',
      'Am7','Em9','Cmaj7','Em9',  'Em9','Cmaj7','G','Em9'
    ],
    melody:[
      ['B4:2','r:2'], ['G4','A4','B4:2'], ['E5:3','D5'], ['B4:2','r:2'],
      ['G4','B4','D5:2'], ['E5:2','F#5:2'], ['G5:3','F#5'], ['E5:2','D5:2'],
      ['B4','A4','G4:2'], ['A4:2','B4:2'], ['D5:3','B4'], ['A4:4'],
      ['G4','A4','B4','D5'], ['E5:2','F#5','G5'], ['F#5:2','E5:2'], ['D5:4'],
      ['B4','D5','E5:2'], ['G5:2','F#5:2'], ['E5','D5','B4:2'], ['A4:2','r:2'],
      ['E5','G5','B5:2'], ['A5:3','G5'], ['F#5:2','E5:2'], ['D5:2','B4:2'],
      ['G5:2','E5:2'], ['D5:2','B4:2'], ['A4','B4','D5:2'], ['E5:4'],
      ['D5','B4','A4:2'], ['G4:2','A4:2'], ['B4:3','r:1'], ['r:4'],
      ['E5:2','D5:2'], ['B4:2','A4:2'], ['G4:2','F#4:2'], ['E4:4'],
      ['B4:2','r:2'], ['G4','A4','B4:2'], ['E5:2','D5:2'], ['B4:2','E5:2']
    ]
  };

  P.firefly = {
    id:'firefly', name:'萤火', bpm:66, beatsPerBar:6,
    bars:[
      ['A4:2','C5:2','F5:2'], ['E5:4','D5:2'], ['C5:2','A4:2','G4:2'], ['A4:6'],
      ['A4:2','C5:2','F5:2'], ['G5:4','F5:2'], ['E5:2','D5:2','C5:2'], ['C5:6']
    ],
    bass:['F2','C3','D3','F2','F2','C3','Bb2','F2']
  };

  /* 留白系（2026-11-18 补）：跟《心象风景》同一路数——慢、悬着、句子没说完就散。
     四条共同规矩：不落强终止；每三四小节留一个整拍静默；低音只在长余韵里露出一点；
     旋律能不跳就不跳，跳也只跳四度以内。 */

  // 雾中回声：D 多利亚，58 BPM。整曲靠 D–A 空五度和 F–E 大二度撑着，几乎不出现三度。
  P.echo = {
    id:'echo', name:'雾中回声', bpm:58, beatsPerBar:4,
    bars:[
      ['D5:2','A4','F4'], ['A4','E5:2','D5'], ['A4:2','r:2'], ['G4','F4','E4:2'],
      ['A4:3','D5'], ['C5:2','B4','r:1'], ['F5','E5','D5:2'], ['C5:2','A4:2'],
      ['B4:2','G4:2'], ['A4:4'], ['D5','F5','E5','C5'], ['D5:2','A4:2']
    ],
    bass:['D2','D2','F2','G2','D2','C3','F2','A2','G2','D2','C3','D2']
  };

  // 雪线以北：e 小调，56 BPM，音区比别的几首高一层，像远处传来的。
  P.snowline = {
    id:'snowline', name:'雪线以北', bpm:56, beatsPerBar:4,
    bars:[
      ['B4:3','E5'], ['G5:2','F#5:2'], ['E5:3','r:1'], ['D5:2','B4:2'],
      ['E5','G5','B5:2'], ['A5:2','G5:2'], ['F#5:3','E5'], ['B4:4'],
      ['D5','E5','F#5','A5'], ['G5:2','F#5:2'], ['E5:2','D5','B4'], ['E5:4']
    ],
    bass:['E2','C3','G2','D3','E2','A2','B2','E2','G2','D3','C3','E2']
  };

  // 空屋：a 小调，52 BPM，最短也最空。第三、四小节加起来只有两个音，剩的全是静默。
  P.vacant = {
    id:'vacant', name:'空屋', bpm:52, beatsPerBar:4,
    bars:[
      ['A4:3','E5'], ['C5:2','r:2'], ['B4:3','A4'], ['r:2','E4:2'],
      ['A4:2','C5:2'], ['F5:3','E5'], ['D5:2','B4','A4'], ['A4:4']
    ],
    bass:['A2','F2','C3','E2','A2','F2','G2','A2']
  };

  // 潮声退去：G 大调但一直用 sus 与加九，不给明确的“回家”；68 BPM 是这几首里最快的。
  P.ebb = {
    id:'ebb', name:'潮声退去', bpm:68, beatsPerBar:4,
    bars:[
      ['G4:2','D5','B4'], ['C5:3','A4'], ['G4:2','r:2'], ['F#4','A4','C5:2'],
      ['D5:3','B4'], ['E5:2','D5','B4'], ['A4:3','G4'], ['r:2','D4:2'],
      ['G4','B4','D5','G5'], ['A5:2','G5:2']
    ],
    bass:['G2','C3','G2','D3','G2','E3','C3','D3','G2','G2']
  };

  P.twinkle = {
    id:'twinkle', name:'小星星', bpm:100, beatsPerBar:4,
    bars:[
      ['C5','C5','G5','G5'], ['A5','A5','G5:2'], ['F5','F5','E5','E5'], ['D5','D5','C5:2'],
      ['G5','G5','F5','F5'], ['E5','E5','D5:2'], ['G5','G5','F5','F5'], ['E5','E5','D5:2'],
      ['C5','C5','G5','G5'], ['A5','A5','G5:2'], ['F5','F5','E5','E5'], ['D5','D5','C5:2']
    ],
    bass:['C3','C3','F3','C3','C3','G2','C3','G2','C3','C3','F3','C3']
  };

  P.ode = {
    id:'ode', name:'欢乐颂', bpm:104, beatsPerBar:4,
    bars:[
      ['E5','E5','F5','G5'], ['G5','F5','E5','D5'], ['C5','C5','D5','E5'], ['E5:1.5','D5:0.5','D5:2'],
      ['E5','E5','F5','G5'], ['G5','F5','E5','D5'], ['C5','C5','D5','E5'], ['D5:1.5','C5:0.5','C5:2'],
      ['E5','E5','F5','G5'], ['G5','F5','E5','D5'], ['C5','C5','D5','E5'], ['E5:1.5','D5:0.5','D5:2'],
      ['E5','E5','F5','G5'], ['G5','F5','E5','D5'], ['C5','C5','D5','E5'], ['D5:1.5','C5:0.5','C5:2']
    ],
    bass:['C3','G2','C3','G2','C3','G2','C3','G2','C3','G2','C3','G2','C3','G2','C3','G2']
  };

  P.elise = {
    id:'elise', name:'致爱丽丝', bpm:112, beatsPerBar:4,
    bars:[
      ['E5:0.5','D#5:0.5','E5:0.5','D#5:0.5','E5:0.5','B4:0.5','D5:0.5','C5:0.5'],
      ['A4:1.5','r:0.5','C4:0.5','E4:0.5','A4:1'],
      ['B4:1.5','r:0.5','E4:0.5','G#4:0.5','B4:1'],
      ['C5:1.5','r:0.5','E4:0.5','E5:0.5','D#5:1'],
      ['E5:0.5','D#5:0.5','E5:0.5','D#5:0.5','E5:0.5','B4:0.5','D5:0.5','C5:0.5'],
      ['A4:1.5','r:0.5','C4:0.5','E4:0.5','A4:1'],
      ['B4:1.5','r:0.5','E4:0.5','C5:0.5','B4:1'],
      ['A4:2','r:2']
    ],
    bass:['A2','A2','E3','A2','A2','A2','E3','A2']
  };

  P.canon = {
    id:'canon', name:'卡农', bpm:92, beatsPerBar:4,
    bars:[
      ['F#5:0.5','E5:0.5','D5:0.5','C#5:0.5','B4:0.5','A4:0.5','B4:0.5','C#5:0.5'],
      ['D5:0.5','C#5:0.5','B4:0.5','A4:0.5','G4:0.5','F#4:0.5','G4:0.5','A4:0.5'],
      ['B4:0.5','A4:0.5','G4:0.5','F#4:0.5','E4:0.5','D4:0.5','E4:0.5','F#4:0.5'],
      ['G4:0.5','F#4:0.5','E4:0.5','D4:0.5','C#4:0.5','B3:0.5','C#4:0.5','D4:0.5'],
      ['F#5:0.5','E5:0.5','D5:0.5','C#5:0.5','B4:0.5','A4:0.5','B4:0.5','C#5:0.5'],
      ['G5:0.5','F#5:0.5','E5:0.5','D5:0.5','C#5:0.5','B4:0.5','C#5:0.5','D5:0.5'],
      ['E5:0.5','D5:0.5','C#5:0.5','B4:0.5','A4:0.5','G4:0.5','A4:0.5','B4:0.5'],
      ['A4:2','B4:2']
    ],
    bass:['D3','A2','B2','F#3','D3','G2','E3','A2']
  };

  P.farewell = {
    id:'farewell', name:'送别', bpm:72, beatsPerBar:4,
    bars:[
      ['G4','E4','G4','C5'], ['B4','A4','G4:2'], ['G4','C5','D5','E5'], ['D5:4'],
      ['G4','E4','G4','C5'], ['B4','A4','G4:2'], ['G4','D5','E5','D5'], ['C5:4']
    ],
    bass:['C3','C3','G2','G2','C3','C3','G2','C3']
  };

  P.jasmine = {
    id:'jasmine', name:'茉莉花', bpm:88, beatsPerBar:4,
    bars:[
      ['E4','E4','G4','A4'], ['C5','C5','A4','G4'], ['G4','A4','G4:2'],
      ['E4','D4','E4','G4'], ['E4:2','D4:2'], ['C4:4']
    ],
    bass:['C3','F3','C3','G2','G2','C3']
  };

  P.tigers = {
    id:'tigers', name:'两只老虎', bpm:104, beatsPerBar:4,
    bars:[
      ['C5','D5','E5','C5'], ['C5','D5','E5','C5'],
      ['E5','F5','G5:2'], ['E5','F5','G5:2'],
      ['G5:0.5','A5:0.5','G5:0.5','F5:0.5','E5','C5'],
      ['G5:0.5','A5:0.5','G5:0.5','F5:0.5','E5','C5'],
      ['C5','G4','C5:2'], ['C5','G4','C5:2']
    ],
    bass:['C3','C3','C3','C3','C3','C3','C3','C3']
  };

  P.jingle = {
    id:'jingle', name:'铃儿响叮当', bpm:126, beatsPerBar:4,
    bars:[
      ['E4','E4','E4:2'], ['E4','E4','E4:2'], ['E4','G4','C5','D5'], ['E5:4'],
      ['F5','F5','F5:2'], ['F5','E5','E5','E5'], ['E5','D5','D5','E5'], ['D5:2','G4:2']
    ],
    bass:['C3','C3','C3','C3','F3','C3','G2','G2']
  };

  // 「随机一首」的池子：短曲优先。八音盒是点一下就响的玩具，
  // 一次放出两分钟会让人找不到停的地方，所以不往里放长曲（windscape2 也不进）。
  var POOL = ['mindscape','echo','snowline','vacant','ebb','cradle','stardust','firefly','twinkle','ode','elise','canon','farewell','jasmine','tigers','jingle'];

  // 曲目单的分组（面板里「挑一首」用）：原创在前，经典与老歌居中，参考长曲殿后。
  // 改曲库时这三行要一起改，否则新曲进不了列表（random 走 POOL，列表走这里）。
  var GROUPS = [
    { t:'原创 · 造梦自有', ids:['mindscape','echo','snowline','vacant','ebb','cradle','stardust','firefly'] },
    { t:'经典', ids:['twinkle','ode','elise','canon'] },
    { t:'老歌 · 童谣', ids:['farewell','jasmine','tigers','jingle'] },
    { t:'参考 · 长曲', ids:['windscape2'] }
  ];

  function secsOf(v){
    if (v.genSeed) return v.chords.length * 4 * 60 / v.bpm;
    if (v.gen) return 36 * 60 / v.bpm;
    if (v.chords) return v.chords.length * 4 * 60 / v.bpm;   // 分解和弦长曲（windscape2）
    return v.bars.length * v.beatsPerBar * 60 / v.bpm;
  }

  /* ---------------- 播放 ---------------- */
  var CUR = null, LAST = '';
  var MB = window.MusicBox = {};

  function state(){
    return CUR
      ? { playing:true, id:CUR.v.id, name:CUR.v.name, seed:CUR.v.genSeed || '' }
      : { playing:false, id:'', name:'', seed:'' };
  }
  function emit(){
    if (typeof MB.onChange === 'function'){ try { MB.onChange(state()); } catch (e) {} }
  }

  function stop(){
    if (!CUR) return false;
    var c = CUR; CUR = null;
    (c.timers || []).forEach(clearTimeout);
    try {
      c.master.gain.cancelScheduledValues(c.ctx.currentTime);
      c.master.gain.setValueAtTime(c.master.gain.value, c.ctx.currentTime);
      c.master.gain.linearRampToValueAtTime(0.0001, c.ctx.currentTime + 0.09);
    } catch (e) {}
    setTimeout(function(){ try { c.ctx.close(); } catch (e) {} }, 220);
    emit();
    return true;
  }

  function start(v){
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    stop();

    var ctx = new AC();
    if (ctx.state === 'suspended'){ try { ctx.resume(); } catch (e) {} }

    var master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.75, ctx.currentTime + 0.05);
    master.connect(ctx.destination);

    /* 一点点空间感：短延迟 + 低通反馈。八音盒在屋里响，不是贴着耳朵响 */
    var dl = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain(), lp = ctx.createBiquadFilter();
    dl.delayTime.value = 0.145; fb.gain.value = 0.22; wet.gain.value = 0.17;
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    master.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(ctx.destination);

    var built = buildTrack(v);
    var spb = 60 / v.bpm;
    var total = built.beats * spb;

    CUR = { ctx: ctx, master: master, v: v, timers: [], total: total };
    var me = CUR;

    /* 分块前瞻：只排未来 2.2 秒的音，每 500ms 补一次。
       短曲一次排完也就几十个音，但生成器拖到 24 小节时是一次上千个振荡器，
       浏览器会卡一下、还可能被限流，所以统一走这条路。 */
    var i = 0, list = built.ev;
    var pump = function(){
      if (CUR !== me) return;
      var horizon = ctx.currentTime + 2.2;
      while (i < list.length){
        var e = list[i];
        var t = me.t0 + e.b * spb;
        if (t > horizon) break;
        strike(ctx, master, e.m, t, e.ring, e.amp, e.np);
        i++;
      }
      if (i < list.length) me.timers.push(setTimeout(pump, 500));
    };
    me.t0 = ctx.currentTime + 0.08;
    pump();

    // 放完自己收尾：不循环，不留一个空 ctx 在身上
    me.timers.push(setTimeout(function(){
      if (CUR !== me) return;
      stop();
    }, (total + 2.2) * 1000));

    emit();
    return {
      id: v.id, name: v.name, seed: v.genSeed || '', secs: total,
      bpm: v.bpm, mood: v.moodLabel || '', density: v.density || '', bars: v.barCount || 0
    };
  }

  MB.stop = stop;
  MB.state = state;
  MB.isPlaying = function(){ return !!CUR; };
  MB.secs = function(id){ return P[id] ? secsOf(P[id]) : 0; };

  /* 作曲页的进度条用：现在放到哪了 / 一共多长（秒）。
     没在放就回 null，页面那边照着把条清零。 */
  MB.progress = function(){
    if (!CUR) return null;
    return { t: Math.max(0, CUR.ctx.currentTime - CUR.t0), total: CUR.total || 0 };
  };

  MB.play = function(id){
    var v = P[id];
    if (!v) return null;
    LAST = id;
    return start(v);
  };

  /* 随机一首，避开上一首（不然「随机」这个词就白说了）*/
  MB.random = function(){
    var pick = '';
    for (var guard = 0; guard < 12; guard++){
      pick = POOL[Math.floor(Math.random() * POOL.length)];
      if (pick !== LAST) break;
    }
    return MB.play(pick);
  };

  MB.list = POOL.map(function(id){ return { id: id, name: P[id].name, secs: secsOf(P[id]) }; });

  /* 曲目单：分组 + 时长，面板里的「挑一首」照着这个画。
     只读，不给外部改曲库（P 是闭包里的私货）。 */
  MB.listAll = function(){
    return GROUPS.map(function(g){
      return {
        t: g.t,
        items: g.ids.map(function(id){
          return { id: id, name: P[id].name, secs: secsOf(P[id]) };
        })
      };
    });
  };

  /* 生成一首并播；opts 里带 seed 就是复现别人的那一首 */
  MB.generate = function(opts){
    var v = buildGenerated(opts || {});
    return start(v);
  };

  /* 拿别人的种子放同一首：参数已经编在种子里，这里不用再传，
     传了也会被种子里的值盖掉（2026-11-18 起）。 */
  MB.playSeed = function(seed){
    if (!seed) return null;
    return MB.generate({ seed: seed });
  };

  /* ---------------- 作曲页（2026-11-19）----------------
     /musicbox 的作曲台一颗颗摆出来的音符，从这里放。
     events = [{ m: midi 音高, b: 第几拍 }]，余韵和音量不用给——八音盒的脾气在这边算，
     跟曲库、生成器同一个 strike，听感是一家人。不落库不传文件，跟种子一个口径。 */
  MB.playSong = function(song){
    if (!song || !Array.isArray(song.events) || !song.events.length) return null;
    var ev = song.events.map(function(e){
      var m = Number(e && e.m);
      if (!(m >= 20 && m <= 108)) m = 72;
      return { m: m, b: Number(e && e.b) || 0, ring: ringOf(m), amp: 0.95, np: 5 };
    }).sort(function(x, y){ return x.b - y.b; });
    var bpm = Number(song.bpm) || 96;
    return start({
      id: 'custom', name: String(song.name || '我的小曲'),
      bpm: Math.max(40, Math.min(200, bpm)),
      events: ev,
      beats: Math.max(1, Number(song.beats) || 8)
    });
  };

  /* 作曲台上点亮一颗格子时当场响一下：点了没声音，用户不知道自己摆没摆上。
     一个常驻的小 ctx（不像 start() 每曲新建），跟 CUR 主播放互不搭界。 */
  var PV = null;
  MB.preview = function(m){
    m = Number(m);
    if (!(m >= 20 && m <= 108)) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!PV){
      var ctx = new AC();
      var out = ctx.createGain();
      out.gain.value = 0.75;
      out.connect(ctx.destination);
      PV = { ctx: ctx, out: out };
    }
    if (PV.ctx.state === 'suspended'){ try { PV.ctx.resume(); } catch (e) {} }
    strike(PV.ctx, PV.out, m, PV.ctx.currentTime + 0.01, ringOf(m), 0.9);
  };
})();
