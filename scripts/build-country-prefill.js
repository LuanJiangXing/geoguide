#!/usr/bin/env node
/**
 * 生成 public/data/country-prefill.json —— review.html「+ Add Country」表单的预填数据。
 *
 * 数据来源（一次性抓取，产物提交进仓库，运行时不联网）：
 *   - 几何：world-atlas countries-50m.json（Natural Earth 1:50m 的 TopoJSON）
 *   - 名称/ISO2：mledoze/countries countries.json
 *
 * 为什么用 50m 而不是 110m：110m 缺 29 个 UN 成员国（新加坡、马耳他、巴林、
 * 马尔代夫这些小国在 1:110m 下根本没有几何），50m 只缺图瓦卢。
 *
 * 边界框取「面积最大的那个多边形」而不是整个 MultiPolygon：
 * 法国（含法属圭亚那）、美国（含阿拉斯加/夏威夷/波多黎各）、荷兰（含加勒比）
 * 这类国家的整体 bbox 会横跨大半个地球，fitBounds 之后整张地图缩到最小。
 * 取最大多边形近似「本土」，和仓库里手工维护的 united-states / hawaii 分行一致。
 *
 * 用法：node scripts/build-country-prefill.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TOPO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
const META_URL = 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json';
const OUT = path.join(__dirname, '..', 'public', 'data', 'country-prefill.json');

/**
 * 归入国土框的邻接距离（度，经纬各自比较）。以最大多边形为锚点，逐级并入
 * 质心相距不超过这个值的多边形，于是：
 *   并入 —— 希腊/意大利/菲律宾/印尼的岛群、新西兰南北岛、马尔代夫环礁
 *   排除 —— 法属圭亚那、阿拉斯加/夏威夷、加那利群岛、复活节岛
 * 阈值取小了会切碎群岛国家，取大了会把海外领地拉进来，6° 是这两个方向的折中。
 */
const NEIGHBOR_DEG = 6;

/**
 * 单靠距离分不开「被海洋切开的国土主体」和「海外领地」——两者距离可以一样远：
 *   马来西亚半岛   占最大多边形 66.7%   离锚点 12.2°   ← 是主体，必须并进来
 *   阿拉斯加       占最大多边形 32.1%   离锚点 53.2°   ← 是飞地，要留在外面
 *   斯瓦尔巴       占最大多边形 27.2%   离锚点 13.8°   ← 是飞地，要留在外面
 *   （对照：法属圭亚那 10.7%、加那利 1.5%）
 * 于是补一条面积判据：大到锚点的这个比例就算国土主体，再远也并进来。
 * 0.4 落在 66.7% 和 32.1% 之间那道很宽的空档里。
 */
const CORE_SHARE = 0.4;

/** 自动策略无能为力的国家，人工给框。只保留真正改变结果的那些。 */
const OVERRIDES = {
  // 跨 180° 经线：多边形被切成两半，最大的一半只是半个国家
  'russia':        { sw: [41.2, 19.6],   ne: [77.7, 180.0] },
  'fiji':          { sw: [-19.2, 177.0], ne: [-16.1, 180.0] },
  // 与 index.html 里手工维护的值保持一致
  'united-states': { sw: [24.5, -125.0], ne: [49.5, -66.9] },
  // 链式沿海岛一路走过了头：挪威的框被拉到斯瓦尔巴(80.5°N)、
  // 新西兰被拉到亚南极的坎贝尔岛(-52.6°S)。这两个只算本土主岛。
  'norway':        { sw: [57.9, 4.6],    ne: [71.2, 31.1] },
  'new-zealand':   { sw: [-47.3, 166.4], ne: [-34.4, 178.6] },
  // 50m 里没有几何，手工补（图瓦卢，UN 成员国中唯一缺的）
  'tuvalu':        { sw: [-10.8, 176.1], ne: [-5.6, 179.9] }
};

/**
 * 上游 name.common 用了新名/全名，但大家仍按旧名或简称搜的情况。
 * 键是数据集里已有的 slug，值是额外接受的写法。
 * ISO2 代码（us/jp/cn…）不用在这里列 —— 客户端会把 flag 一起建索引。
 */
const ALIASES = {
  'turkiye': 'turkey',
  'czechia': 'czech-republic',
  'eswatini': 'swaziland',
  'north-macedonia': 'macedonia',
  'myanmar': 'burma',
  'cape-verde': 'cabo-verde',
  'timor-leste': 'east-timor',
  'ivory-coast': 'cote-d-ivoire',
  'dr-congo': 'democratic-republic-of-the-congo',
  'united-states': 'usa',
  'united-kingdom': 'uk',
  'united-arab-emirates': 'uae',
  'saudi-arabia': 'ksa',
  'south-korea': 'korea',
  'central-african-republic': 'car',
  'bosnia-and-herzegovina': 'bosnia',
  'trinidad-and-tobago': 'trinidad',
  'antigua-and-barbuda': 'antigua',
  'saint-vincent-and-the-grenadines': 'saint-vincent',
  'sao-tome-and-principe': 'sao-tome',
  'papua-new-guinea': 'png'
};

/** 不加进预填数据的条目。 */
const EXCLUDE = new Set(['antarctica']);

/** TopoJSON 解码：把 quantized delta 弧还原成经纬度点串。 */
function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map(function(arc) {
    let x = 0, y = 0;
    return arc.map(function(p) {
      x += p[0]; y += p[1];
      return [x * sx + tx, y * sy + ty];
    });
  });
}

/** 由弧索引取出环上的点；索引为负表示该弧反向。 */
function ringPoints(arcIndexes, arcs) {
  const pts = [];
  arcIndexes.forEach(function(idx, i) {
    const arc = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx];
    // 相邻弧首尾点重复，跳过每段第一个点（第一段除外）
    pts.push.apply(pts, i === 0 ? arc : arc.slice(1));
  });
  return pts;
}

/** 平面近似面积（度²），只用来比较大小。 */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return sum / 2;
}

function bboxOf(ring) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  ring.forEach(function(p) {
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
  });
  return { sw: [s, w], ne: [n, e] };
}

/** 取出一个 geometry 的所有外环。 */
function outerRings(geometry, arcs) {
  let polys;
  if (geometry.type === 'Polygon') {
    polys = [geometry.arcs];
  } else if (geometry.type === 'MultiPolygon') {
    polys = geometry.arcs;
  } else {
    return [];
  }
  return polys.map(function(poly) { return ringPoints(poly[0], arcs); });
}

function centroidOf(ring) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  ring.forEach(function(p) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  });
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * 从一个国家的全部外环算出国土框：以最大多边形为锚点，逐级并入质心在
 * NEIGHBOR_DEG 之内的多边形，避免把海外领地算进本土（见 NEIGHBOR_DEG 注释）。
 */
function countryBbox(rings) {
  if (!rings.length) return null;
  const parts = rings.map(function(ring) {
    return { ring: ring, area: Math.abs(ringArea(ring)), c: centroidOf(ring) };
  });
  parts.sort(function(a, b) { return b.area - a.area; });

  const used = [parts[0]];
  const rest = parts.slice(1);
  let grew = true;
  while (grew && rest.length) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      const p = rest[i];
      const near = used.some(function(u) {
        return Math.abs(u.c[0] - p.c[0]) <= NEIGHBOR_DEG && Math.abs(u.c[1] - p.c[1]) <= NEIGHBOR_DEG;
      });
      // 国土主体再远也并（马来西亚半岛），小块的飞地哪怕很近也是逐级链进来的
      if (near || p.area >= CORE_SHARE * parts[0].area) {
        p.viaShare = !near;
        used.push(p);
        rest.splice(i, 1);
        grew = true;
      }
    }
  }

  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  used.forEach(function(p) {
    const b = bboxOf(p.ring);
    if (b.sw[0] < s) s = b.sw[0];
    if (b.sw[1] < w) w = b.sw[1];
    if (b.ne[0] > n) n = b.ne[0];
    if (b.ne[1] > e) e = b.ne[1];
  });

  // 丢掉的部分一并返回：国土被切开的国家只能靠这份报告发现（马来西亚就是这么漏的）
  const totalArea = parts.reduce(function(sum, p) { return sum + p.area; }, 0);
  const dist = function(p) { return Math.max(Math.abs(parts[0].c[0] - p.c[0]), Math.abs(parts[0].c[1] - p.c[1])); };
  const dropped = rest.filter(function(p) { return p.area / totalArea > 0.02; }).map(function(p) {
    return { share: p.area / totalArea, dist: dist(p), c: p.c };
  });
  // 只靠逐级链式并入、却离锚点很远的块：链式能跨岛链一路走过去，可能走过头（斯瓦尔巴）
  const farChained = used.filter(function(p) { return !p.viaShare && dist(p) > 8; }).map(function(p) {
    return { share: p.area / totalArea, dist: dist(p), c: p.c };
  });

  return { sw: [s, w], ne: [n, e], dropped: dropped, farChained: farChained };
}

function slugify(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // Côte d'Ivoire → Cote d'Ivoire
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 两位小数：一位会把摩纳哥/马尔代夫这种小国的框压成零面积
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 抓取结果缓存到临时目录：50m 的 TopoJSON 有好几 MB，每次重跑都下载太慢，
 * 而且上游抖一下整个生成就断了。缓存文件不进仓库，删掉就会重新下载。
 */
async function getJSON(url) {
  const cacheFile = path.join(os.tmpdir(), 'geoguide-prefill-' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + '.json');
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
  const text = await res.text();
  fs.writeFileSync(cacheFile, text);
  console.log('已缓存 ' + url);
  return JSON.parse(text);
}

(async function main() {
  const [topo, meta] = await Promise.all([getJSON(TOPO_URL), getJSON(META_URL)]);
  const arcs = decodeArcs(topo);

  // ccn3（三位数字码）→ {cca2, name}
  const byCcn3 = new Map();
  meta.forEach(function(c) {
    if (c.ccn3) byCcn3.set(String(c.ccn3), { cca2: (c.cca2 || '').toLowerCase(), name: c.name.common });
  });

  // 同一个 ccn3 可能对应多个 feature —— 数据集把澳属的阿什莫尔礁也标成了
  // 澳大利亚的 036，逐个 feature 算框会被这块礁石覆盖掉整个国家。
  // 先按国家把外环并起来，再统一算框。
  const ringsByCcn3 = new Map();
  const skipped = [];
  topo.objects.countries.geometries.forEach(function(g) {
    const m = byCcn3.get(String(g.id));
    if (!m || !m.cca2) { skipped.push(g.properties && g.properties.name); return; }
    const rings = outerRings(g, arcs);
    if (!rings.length) { skipped.push(g.properties && g.properties.name); return; }
    if (!ringsByCcn3.has(String(g.id))) ringsByCcn3.set(String(g.id), []);
    ringsByCcn3.get(String(g.id)).push.apply(ringsByCcn3.get(String(g.id)), rings);
  });

  const out = {};
  const truncList = [];
  const chainList = [];
  ringsByCcn3.forEach(function(rings, ccn3) {
    const m = byCcn3.get(ccn3);
    const slug = slugify(m.name);
    if (EXCLUDE.has(slug)) return;
    const box = countryBbox(rings);
    if (!box) return;
    if (box.dropped.length) truncList.push({ slug: slug, dropped: box.dropped });
    if (box.farChained.length) chainList.push({ slug: slug, far: box.farChained });
    out[slug] = {
      name: m.name,
      flag: m.cca2,
      sw: [round2(box.sw[0]), round2(box.sw[1])],
      ne: [round2(box.ne[0]), round2(box.ne[1])]
    };
  });

  // 人工覆盖：几何算不出来的国家直接补条目，其余只改框
  Object.keys(OVERRIDES).forEach(function(slug) {
    if (!out[slug]) {
      if (slug !== 'tuvalu') { console.warn('override 无对应国家，忽略：' + slug); return; }
      const tu = meta.find((c) => c.cca2 === 'TV');
      out[slug] = { name: tu.name.common, flag: 'tv' };
    }
    out[slug].sw = OVERRIDES[slug].sw.slice();
    out[slug].ne = OVERRIDES[slug].ne.slice();
  });

  // 别名：指向已有条目，客户端建索引时一并注册
  const aka = {};
  Object.keys(ALIASES).forEach(function(slug) {
    if (!out[slug]) { console.warn('别名指向不存在的条目，忽略：' + slug); return; }
    aka[ALIASES[slug]] = slug;
  });

  const sorted = {};
  Object.keys(out).sort().forEach(function(k) { sorted[k] = out[k]; });

  // 一行一条，diff 友好；_aka 是别名表，客户端跳过下划线开头的键
  const lines = ['"_aka":' + JSON.stringify(aka)].concat(
    Object.keys(sorted).map(function(k) { return JSON.stringify(k) + ':' + JSON.stringify(sorted[k]); })
  );
  fs.writeFileSync(OUT, '{\n' + lines.join(',\n') + '\n}\n');

  console.log('写入 ' + OUT + '：' + Object.keys(sorted).length + ' 条，别名 ' + Object.keys(aka).length + ' 条');
  console.log('无 ISO2/几何、已跳过：' + JSON.stringify(skipped));

  // --- 质量诊断 ---
  const inverted = Object.keys(sorted).filter(function(k) {
    const c = sorted[k];
    return c.sw[0] >= c.ne[0] || c.sw[1] >= c.ne[1];
  });
  console.log('\n⚠ sw/ne 反了：' + (inverted.length ? JSON.stringify(inverted) : '无'));

  const wide = Object.keys(sorted).filter(function(k) {
    const c = sorted[k];
    return (c.ne[1] - c.sw[1]) > 60 || (c.ne[0] - c.sw[0]) > 60;
  });
  console.log('跨 >60° 的（预填会很宽）：');
  wide.forEach(function(k) {
    const c = sorted[k];
    console.log('  ' + k + '  sw=' + JSON.stringify(c.sw) + ' ne=' + JSON.stringify(c.ne));
  });

  // 被 NEIGHBOR_DEG 切掉、且丢掉的部分占国土 2% 以上的国家。
  // 这些框会明显偏小，值得逐个人工确认（override 或调阈值）。
  truncList.sort(function(a, b) { return b.dropped[0].share - a.dropped[0].share; });
  console.log('\n国土被切开、丢掉 >2% 的国家（' + truncList.length + ' 个）：');
  truncList.forEach(function(t) {
    const d = t.dropped[0];
    console.log('  ' + t.slug.padEnd(26) + ' 丢掉 ' + (d.share * 100).toFixed(1).padStart(5) + '%  离锚点 ' + d.dist.toFixed(1).padStart(5) + '°  质心 ' + JSON.stringify(d.c.map(function(v) { return Math.round(v * 10) / 10; })) + (OVERRIDES[t.slug] ? '  [已人工覆盖]' : ''));
  });

  // 只靠链式并入、离锚点 >8° 的块。链式能沿海岛链一路走，可能走过头（挪威把斯瓦尔巴带进来了）。
  chainList.sort(function(a, b) { return b.far[0].dist - a.far[0].dist; });
  console.log('\n链式并入偏远地块（离锚点 >8°）的国家（' + chainList.length + ' 个）：');
  chainList.forEach(function(t) {
    const f = t.far[0];
    console.log('  ' + t.slug.padEnd(26) + ' 共 ' + t.far.length + ' 块，最远 ' + f.dist.toFixed(1).padStart(5) + '°  质心 ' + JSON.stringify(f.c.map(function(v) { return Math.round(v * 10) / 10; })) + (OVERRIDES[t.slug] ? '  [已人工覆盖]' : ''));
  });

  const KNOWN = {
    'paraguay': { sw: [-27.6, -62.6], ne: [-19.3, -54.3] },
    'united-states': { sw: [24.5, -125.0], ne: [49.5, -66.9] }
  };
  console.log('\n与仓库手工值对比（差值）：');
  Object.keys(KNOWN).forEach(function(k) {
    const a = sorted[k], b = KNOWN[k];
    if (!a) { console.log('  ' + k + '：生成数据里没有'); return; }
    console.log('  ' + k + '  Δsw=[' + (a.sw[0] - b.sw[0]).toFixed(1) + ',' + (a.sw[1] - b.sw[1]).toFixed(1)
      + '] Δne=[' + (a.ne[0] - b.ne[0]).toFixed(1) + ',' + (a.ne[1] - b.ne[1]).toFixed(1) + ']');
  });

  console.log('\n样例：');
  ['china', 'japan', 'turkiye', 'singapore', 'maldives', 'south-africa'].forEach(function(k) {
    console.log('  ' + k + ' → ' + JSON.stringify(sorted[k]));
  });
})().catch(function(e) { console.error(e); process.exit(1); });
