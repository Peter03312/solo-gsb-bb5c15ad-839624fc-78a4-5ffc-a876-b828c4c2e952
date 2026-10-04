#!/usr/bin/env bash
# 长链（数千事件逐日相接）校验 / 即时发布 / 预约发布 端到端调用示例。
#
# 背景：编辑者分批整理出逐日相接的 6000 个事件与 5999 条「先于」关系。
# 早期实现在发布校验时用递归 Tarjan 做关系成环检测，链一长就调用栈溢出，
# 编辑台收到 500，无法即时发布也无法建立预约。现求解已改为显式工作栈，
# 三个入口（validate / publish / schedules）对同一草稿给出一致结果。
#
# 本脚本只用现有 HTTP API（请求体均落临时文件，规避命令行长度上限；
# 整理包按 ≤1200 事件分批导入，遵守服务端 1MB 请求体上限）。
#
# 默认在临时端口 + 临时数据库上各起一个干净服务端，顺序演示三种草稿
# （可解 / 时间无解 / 关系成环），结束后自动关闭并删除临时库：
#   1) 分批写入 N 个事件 / 日精度主张与「先于」链边（跨批边用关系接口补建）；
#   2) POST /api/editor/validate  —— 发布前校验（不落库），返回每个事件的求解日；
#   3) POST /api/editor/publish   —— 即时发布不可变版本；
#   4) POST /api/editor/schedules —— 用同一份选择建立未来预约（冻结求解日）；
#   5) 时间无解 / 关系成环时三处同一错误结构，publish / schedules 返回 422，
#      失败不写版本、不写预约。
#
# 也可对一个已在运行的服务端演示「可解长链」单场景：
#   BASE=http://localhost:3000 TOKEN=editor SCENARIO=feasible bash examples/long-chain-example.sh
# 依赖：curl 与 node。可重复运行（批次标识带时间戳）。默认 6000 个事件，可用 N=12000。
set -euo pipefail

BASE="${BASE:-}"
TOKEN="${TOKEN:-editor}"
N="${N:-6000}"
BATCH=1200
SCENARIO="${SCENARIO:-all}"          # all | feasible | temporal | cycle
TS="$(date +%s)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
SRV_PID=""
OWN_SERVER=0
PORT=""
trap 'cleanup' EXIT
cleanup() {
  if [ "$OWN_SERVER" = 1 ] && [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; fi
  rm -rf "$DIR"
}

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(eval(process.argv[1])))' "$1"; }
h_get() { curl -s -H "X-Editor-Token: ${TOKEN}" "$@"; }
# post_file <url> <bodyFile>
post_file() { curl -s -X POST -H 'Content-Type: application/json' -H "X-Editor-Token: ${TOKEN}" "$1" --data-binary "@$2"; }
http_post_file() { curl -s -o "$1" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "X-Editor-Token: ${TOKEN}" "$2" --data-binary "@$3"; }
utc_in() { node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*1000).toISOString().replace(/\.\d{3}Z$/,"Z"))' -- "$1"; }

# 在全新临时库上起一个本服务端（用于多场景隔离；校验始终覆盖整个草稿）
start_fresh_server() {
  PORT="$(( ( RANDOM % 20000 ) + 20000 ))"
  local db="$DIR/db-$1.sqlite"
  DB_PATH="$db" PORT="$PORT" EDITOR_TOKEN="$TOKEN" node "$ROOT/src/server.js" > "$DIR/server-$1.log" 2>&1 &
  SRV_PID=$!
  OWN_SERVER=1
  BASE="http://127.0.0.1:$PORT"
  # 等待端口就绪
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/public/versions"; then return 0; fi
    sleep 0.2
  done
  echo "本地服务端未就绪，日志：" >&2; cat "$DIR/server-$1.log" >&2; exit 1
}
stop_fresh_server() {
  if [ "$OWN_SERVER" = 1 ] && [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; fi
  SRV_PID=""; OWN_SERVER=0
}

# 生成一批整理包：事件 beg..end，各一条日精度主张 + 批内相邻链边。
# 事件 i：feasible/cycle 钉在 1958-01-01 起第 i 天；temporal 全部钉首日。
gen_bundle() {
  local mode="$1" out="$2" bid="$3" beg="$4" end="$5"
  MODE="$mode" BEG="$beg" END="$end" BID="$bid" node - "$out" <<'JS'
const fs = require('fs');
const mode = process.env.MODE;
const beg = Number(process.env.BEG);
const end = Number(process.env.END);
const base = Date.UTC(1958, 0, 1);
const dayMs = 86400000;
const events = [];
for (let i = beg; i <= end; i++) {
  const d = new Date(mode === 'temporal' ? base : base + (i - 1) * dayMs);
  events.push({
    key: `ev-${i}`,
    title: `长链事件 ${i}`,
    claims: [{ precision: 'day', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), source: `逐日排比，链证 ${i}` }],
  });
}
const relations = [];
for (let i = beg; i < end; i++) {
  relations.push({ earlierKey: `ev-${i}`, laterKey: `ev-${i + 1}`, source: '逐日相接' });
}
fs.writeFileSync(process.argv[2], JSON.stringify({ batchId: process.env.BID, events, relations }));
JS
}

import_one() {
  local bundle="$1" bidx="$2" mode="$3"
  local prev="$DIR/preview-$mode-$bidx.json" conf="$DIR/confirm-$mode-$bidx.json"
  post_file "$BASE/api/editor/import-preview" "$bundle" > "$prev"
  local rev; rev="$(jfield 'd.draftRevisionNo' < "$prev")"
  PV="$prev" CF="$conf" RV="$rev" node - "$bundle" <<'JS'
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fp = JSON.parse(fs.readFileSync(process.env.PV, 'utf8')).fingerprint;
fs.writeFileSync(process.env.CF, JSON.stringify({ bundle: b, fingerprint: fp, draftRevisionNo: Number(process.env.RV) }));
JS
  post_file "$BASE/api/editor/import" "$conf"
}

# 为整份草稿（恰好 N 个事件）构造 selection 文件
write_selection() {
  local out="$1"
  h_get "$BASE/api/editor/state" \
    | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(JSON.stringify(d.events.map(e=>{const c=(e.claims||[]).find(c=>c.eventId===e.id)||e.claims[0];return {eventId:e.id,claimId:c.id};})))' > "$out"
}

# 由 selection 文件 + key=value（整数自动转数字）组装请求体文件
wrap_body() {
  local selFile="$1" out="$2"; shift 2
  SELF="$selFile" OUT="$out" node - "$@" <<'JS'
const fs = require('fs');
const body = { selection: JSON.parse(fs.readFileSync(process.env.SELF, 'utf8')) };
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=');
  const k = arg.slice(0, eq);
  let v = arg.slice(eq + 1);
  if (/^-?\d+$/.test(v)) v = Number(v);
  body[k] = v;
}
fs.writeFileSync(process.env.OUT, JSON.stringify(body));
JS
}

# 在当前（干净）服务端导入一个场景：N 事件 + N-1 条链边（cycle 再加 N→1）
import_draft() {
  local mode="$1"
  say "[$mode] 1) 分批导入事件与批内关系（共 $N 事件；每批 ≤$BATCH，遵守服务端 1MB 请求体上限）"
  local beg=1 end bidx=0
  while [ "$beg" -le "$N" ]; do
    end=$(( beg + BATCH - 1 )); [ "$end" -gt "$N" ] && end="$N"
    bidx=$(( bidx + 1 ))
    local f="$DIR/bundle-$mode-$bidx.json"
    gen_bundle "$mode" "$f" "long-chain-${TS}-${mode}-${bidx}" "$beg" "$end"
    local imported; imported="$(import_one "$f" "$bidx" "$mode")"
    echo "  批次 $bidx：$(printf '%s' "$imported" | jfield 'd.counts.eventCount+" 事件 / "+d.counts.relationCount+" 关系"')"
    beg=$(( end + 1 ))
  done

  say "[$mode] 1b) 用关系接口补建跨批衔接边"
  local ids; ids="$(h_get "$BASE/api/editor/state" \
    | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.events.map(e=>e.id).join(","))')"
  local nbatch=$(( (N + BATCH - 1) / BATCH )) boundary=0 b=2
  while [ "$b" -le "$nbatch" ]; do
    local firstIdx prevIdx first prev
    firstIdx=$(( (b - 1) * BATCH + 1 ))
    prevIdx=$(( firstIdx - 1 ))
    first="$(printf '%s' "$ids" | node -e 'const a=require("fs").readFileSync(0,"utf8").split(",");process.stdout.write(a[Number(process.argv[1])-1])' "$firstIdx")"
    prev="$(printf '%s' "$ids" | node -e 'const a=require("fs").readFileSync(0,"utf8").split(",");process.stdout.write(a[Number(process.argv[1])-1])' "$prevIdx")"
    curl -s -X POST -H 'Content-Type: application/json' -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/relations" \
      -d "{\"earlierId\":$prev,\"laterId\":$first,\"source\":\"逐日相接（跨批衔接）\"}" >/dev/null
    boundary=$(( boundary + 1 ))
    b=$(( b + 1 ))
  done
  if [ "$mode" = cycle ]; then
    local first last
    first="$(printf '%s' "$ids" | node -e 'const a=require("fs").readFileSync(0,"utf8").split(",");process.stdout.write(a[0])')"
    last="$(printf '%s' "$ids" | node -e 'const a=require("fs").readFileSync(0,"utf8").split(",");process.stdout.write(a[a.length-1])')"
    curl -s -X POST -H 'Content-Type: application/json' -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/relations" \
      -d "{\"earlierId\":$last,\"laterId\":$first,\"source\":\"末例回连（成环）\"}" >/dev/null
    boundary=$(( boundary + 1 ))
  fi
  echo "  补建边数：$boundary"
}

latest_no() { h_get "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }

# ================= 场景一：可解长链，三处一致 =================
run_feasible() {
  import_draft feasible
  write_selection "$DIR/selection.json"

  say "[feasible] 2) 发布前校验 validate（旧实现在此 500 栈溢出）"
  wrap_body "$DIR/selection.json" "$DIR/req.json"
  post_file "$BASE/api/editor/validate" "$DIR/req.json" > "$DIR/validate.json"
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(!d.ok){console.error("期望 ok=true，实际：",JSON.stringify(d).slice(0,300));process.exit(1);}
    const p=d.preview;
    console.log("ok=true，preview 事件数 =", p.length);
    console.log("首个求解日 =", p[0].resolvedDate, "；末个求解日 =", p[p.length-1].resolvedDate);
    let bad=0;
    for(let i=1;i<p.length;i++){
      if(Date.parse(p[i].resolvedDate)-Date.parse(p[i-1].resolvedDate)!==86400000) bad++;
      if(!(p[i].resolvedDate>=p[i].intervalStart && p[i].resolvedDate<=p[i].intervalEnd)) bad++;
    }
    console.log(bad===0 ? "OK：每条关系两端恰好相差一天，求解日均在主张区间内" : ("FAIL 违规边数 "+bad));
    if(bad) process.exit(1);
  ' "$DIR/validate.json"

  say "[feasible] 3) 即时发布 publish（基准 0 → 第 1 版）"
  V0="$(latest_no)"
  wrap_body "$DIR/selection.json" "$DIR/req.json" "baseVersionNo=$V0" "editor=长链脚本" "note=$N 事件逐日相接"
  post_file "$BASE/api/editor/publish" "$DIR/req.json" > "$DIR/publish.json"
  node -e '
    const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const p=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).preview;
    if(v.status===422){console.error("发布失败：",JSON.stringify(v.errors).slice(0,300));process.exit(1);}
    const got=new Map(v.version.events.map(e=>[e.eventId,e.resolvedDate]));
    let mismatch=0; for(const row of p) if(got.get(row.eventId)!==row.resolvedDate) mismatch++;
    console.log("版本号 =", v.versionNo, "；事件 =", v.version.eventCount, "；关系 =", v.version.relationCount, "；与校验求解日不一致条数 =", mismatch);
    if(mismatch) process.exit(1);
  ' "$DIR/publish.json" "$DIR/validate.json"
  V1="$(latest_no)"

  say "[feasible] 4) 建立 2 小时后的预约 schedules（基于第 $V1 版，冻结同一组求解日）"
  wrap_body "$DIR/selection.json" "$DIR/req.json" "scheduledAt=$(utc_in 7200)" "baseVersionNo=$V1" "editor=长链脚本"
  post_file "$BASE/api/editor/schedules" "$DIR/req.json" > "$DIR/schedule.json"
  node -e '
    const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schedule;
    const p=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).preview;
    const got=new Map(s.frozen.events.map(e=>[e.eventId,e.resolvedDate]));
    let mismatch=0; for(const row of p) if(got.get(row.eventId)!==row.resolvedDate) mismatch++;
    console.log("预约号 =", s.scheduleNo, "状态 =", s.status, "；事件 =", s.eventCount, "；关系 =", s.relationCount, "；与校验求解日不一致条数 =", mismatch);
    if(s.status!=="pending"||mismatch) process.exit(1);
  ' "$DIR/schedule.json" "$DIR/validate.json"
  echo "三入口对同一草稿给出同一组求解日（脚本内已比对，0 不一致）。"
  echo "该预约保持 pending，可用 DELETE /api/editor/schedules/<号> 在到期前取消。"
}

# 失败场景：三入口同一错误结构；publish / schedules 为 422；不写版本、不写预约。
run_fail() {
  local type="$1"
  import_draft "$type"
  write_selection "$DIR/selection.json"
  local base; base="$(latest_no)"
  say "[$type] validate / publish / schedules 都应报 $type；后两者 HTTP 422，不写版本 / 预约"

  wrap_body "$DIR/selection.json" "$DIR/req.json"
  post_file "$BASE/api/editor/validate" "$DIR/req.json" \
    | node -e 'const want=process.argv[1];const d=JSON.parse(require("fs").readFileSync(0,"utf8"));if(d.ok||d.errors[0].type!==want){console.error("FAIL validate",JSON.stringify(d).slice(0,200));process.exit(1)}console.log("validate: ok=false，type="+want+"，见证事件",d.errors[0].eventIds.length,"个、关系",d.errors[0].relationIds.length,"条")' "$type"

  wrap_body "$DIR/selection.json" "$DIR/req.json" "baseVersionNo=$base"
  local code; code="$(http_post_file "$DIR/pub.json" "$BASE/api/editor/publish" "$DIR/req.json")"
  [ "$code" = 422 ] || { echo "FAIL publish 期望 422 实际 $code：$(head -c 200 "$DIR/pub.json")"; exit 1; }
  echo "publish: HTTP 422，type=$(jfield 'd.errors[0].type' < "$DIR/pub.json")"

  wrap_body "$DIR/selection.json" "$DIR/req.json" "scheduledAt=$(utc_in 7200)" "baseVersionNo=$base"
  code="$(http_post_file "$DIR/sch.json" "$BASE/api/editor/schedules" "$DIR/req.json")"
  [ "$code" = 422 ] || { echo "FAIL schedules 期望 422 实际 $code：$(head -c 200 "$DIR/sch.json")"; exit 1; }
  echo "schedules: HTTP 422，type=$(jfield 'd.errors[0].type' < "$DIR/sch.json")"

  local vers sch
  vers="$(h_get "$BASE/api/public/versions" | jfield 'd.versions.length')"
  sch="$(h_get "$BASE/api/editor/schedules" | jfield 'd.schedules.length')"
  echo "版本数 = $vers（期望 0），预约数 = $sch（期望 0）：失败均未落库"
  [ "$vers" = 0 ] && [ "$sch" = 0 ] || { echo "FAIL：失败路径写入了数据"; exit 1; }
}

if [ -n "$BASE" ]; then
  # 对外部已运行服务端：只演示指定单场景（避免与库中既有草稿互相干扰）
  say "对已运行服务端 $BASE 演示单场景：$SCENARIO"
  case "$SCENARIO" in
    feasible) run_feasible ;;
    temporal|cycle) run_fail "$SCENARIO" ;;
    all) echo "SCENARIO=all 需要本脚本自管临时服务端；请省略 BASE，或指定 SCENARIO=feasible|temporal|cycle"; exit 1 ;;
    *) echo "未知 SCENARIO=$SCENARIO"; exit 1 ;;
  esac
  exit 0
fi

# 默认：自管三个隔离的临时服务端，顺序演示全部场景
say "长链规模 N=$N；每个场景使用独立临时库，互不影响"
start_fresh_server feasible;  run_feasible;            stop_fresh_server
start_fresh_server temporal;  run_fail temporal;       stop_fresh_server
start_fresh_server cycle;     run_fail cycle;          stop_fresh_server

printf '\n\033[1;32m长链示例全部通过：校验 / 即时发布 / 预约结果一致；成环与时间无解沿用既有错误结构（422）且不落库。\033[0m\n'
