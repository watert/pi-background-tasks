#!/usr/bin/env bun
/**
 * 迁移历史 bg 任务产物：<project>/.pi/{delegate,tasks} → ~/.pi/bg-tasks/{delegate,tasks}
 *
 * 背景：pi-background-tasks 上游把三类产物硬编码在 <cwd>/.pi 下。本 fork 改为
 * 统一落在 Pi home 的 runtime root（PI_BG_RUNTIME_DIR，缺省 ~/.pi/bg-tasks），
 * 这样运行时状态不再进仓库 / iCloud vault，且能被只扫 Pi session 树的采集器看到。
 *
 * 两件事必须一起做，缺一不可：
 * 1. 移动目录树；
 * 2. 改写 task 元数据里记录的路径。`<taskId>.json` 的 outputPath 原本是 cwd 相对
 *    路径（`.pi/tasks/<run>/<id>.output`），移动后就是死链。delegate 侧同理：
 *    `<taskId>.json` 的 delegate.artifactDir / outputPath，以及 manifest 里的
 *    child_session_dir 都指向旧位置。
 *
 * 安全约束：
 * - 目标已存在同名 run 目录时跳过并报告，绝不覆盖（run 目录名 = <sessionId>-<pid>，
 *   理论上唯一，撞名说明有异常，宁可留旧数据也不丢新数据）。
 * - 默认 dry-run；--apply 才真正动手。
 * - 移动用 rename，跨设备自动降级为 copy+unlink。
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.env['PI_BG_RUNTIME_DIR']?.trim() || join(homedir(), '.pi', 'bg-tasks');

/** 参与迁移的项目目录：默认扫 ~/www 与 vault，显式传参可覆盖 */
const PROJECTS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DEFAULT_PROJECTS = [
  join(homedir(), 'www/github/housipaya'),
  join(homedir(), 'www/github/thera-edge-one'),
  join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/watert/user-docs'),
];
const projects = PROJECTS.length ? PROJECTS : DEFAULT_PROJECTS;

const KINDS = ['delegate', 'tasks'];

let moved = 0;
let skipped = 0;
let rewritten = 0;
let bytes = 0;
const collisions = [];

function dirSize(p) {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

/** 跨设备 rename 会 EXDEV，失败时退回 copy + unlink */
function moveDir(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * 旧路径 → 新 runtime 路径。
 *
 * 旧数据里有三种形态，都必须一起改，否则迁移后留下死链：
 *   1. 相对：`.pi/tasks/<run>/<id>.output`（task json 的 outputPath）
 *   2. 绝对：`<project>/.pi/delegate/<run>/<taskId>`（delegate.artifactDirAbs）
 *   3. 嵌在命令行里：`--session-dir '<project>/.pi/delegate/.../child-session'`
 *
 * 用通用正则而不是「项目 × run 目录」的精确匹配，有两个原因：
 * - 目录名与文件内记录的 run 目录可能不一致（缺 sessionId 时目录回落成
 *   `session-<pid>-<pid>`，而 json 里记的是真实 sessionId），精确匹配会漏；
 * - 相对形式与属主项目无关，若按项目逐个处理，先跑到的项目会在轮到真正属主之前
 *   就把相对路径改掉，留下 `<project><ROOT>/...` 这种拼接畸形。
 *
 * 正则只吃 `<前缀>/.pi/(delegate|tasks)/`，前缀部分整体丢弃，因此绝对与相对
 * 两种形态一次覆盖，且不会误伤恰好出现 `.pi/` 字样的命令文本。
 */
const OLD_PATH_RE = /[^\s"']*?\.pi\/(delegate|tasks)\//g;

function rewritePaths(text) {
  return text.replace(OLD_PATH_RE, (_m, kind) => `${ROOT}/${kind}/`);
}

/**
 * 受 sha256 存证保护的文件：一个字节都不能动。
 * `seed.json` 是 delegate 启动时的父上下文投影，manifest 记录了它的摘要；
 * 改写内容会让 bg_result 的完整性校验失败。
 */
const ATTESTED = new Set(['seed.json', 'child-prompt.txt']);

/** 递归改写 json 里的旧路径引用（只处理 manifest 与 task 元数据） */
function rewriteFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      n += rewriteFiles(full);
      continue;
    }
    // 只改元数据类文件；.output / .jsonl 是原始日志与事件流，不动
    if (!e.name.endsWith('.json')) continue;
    if (ATTESTED.has(e.name)) continue;
    const before = readFileSync(full, 'utf8');
    const after = rewritePaths(before);
    if (before === after) continue;
    if (APPLY) {
      JSON.parse(after); // 改完必须仍是合法 JSON
      writeFileSync(full, after);
    }
    n += 1;
  }
  return n;
}

/**
 * 补扫：修掉首轮迁移漏掉的引用（可重复执行，幂等）。
 * 目录名与文件内记录的 run 目录可能不一致，所以这里不按 run 目录匹配，
 * 直接对 runtime root 下的元数据做一次通用改写。
 */
function sweepLeftovers() {
  if (!existsSync(ROOT)) return 0;
  let n = 0;
  for (const kind of KINDS) {
    const kindDir = join(ROOT, kind);
    if (!existsSync(kindDir)) continue;
    n += rewriteFiles(kindDir);
  }
  return n;
}

for (const project of projects) {
  const piDir = join(project, '.pi');
  if (!existsSync(piDir)) continue;

  for (const kind of KINDS) {
    const src = join(piDir, kind);
    if (!existsSync(src)) continue;

    const dstKind = join(ROOT, kind);
    if (APPLY) mkdirSync(dstKind, { recursive: true, mode: 0o700 });

    for (const run of readdirSync(src, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const from = join(src, run.name);
      const to = join(dstKind, run.name);

      if (existsSync(to)) {
        skipped += 1;
        collisions.push(`${kind}/${run.name} → 已存在，跳过`);
        continue;
      }

      const size = dirSize(from);
      const nRewritten = rewriteFiles(from);
      bytes += size;
      moved += 1;
      rewritten += nRewritten;
      console.log(
        `${APPLY ? '移动' : '将移动'} ${basename(project)}/.pi/${kind}/${run.name}` +
          `  (${(size / 1024).toFixed(0)}K, 改写 ${nRewritten} 个元数据)`,
      );
      if (APPLY) moveDir(from, to);
    }

    // 源目录清空后回收，只在 apply 且确实空了才删
    if (APPLY && readdirSync(src).length === 0) rmSync(src, { recursive: true, force: true });
  }

  if (APPLY && existsSync(piDir) && readdirSync(piDir).every((n) => n === '.DS_Store')) {
    rmSync(piDir, { recursive: true, force: true });
  }
}

console.log(`\nruntime root: ${ROOT}`);
console.log(`模式: ${APPLY ? 'APPLY（已实际改动）' : 'DRY-RUN（未改动任何文件）'}`);
console.log(`run 目录: ${moved} 个待处理, ${skipped} 个跳过, 共 ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`元数据改写: ${rewritten} 个文件`);

// 补扫跨 kind 引用（task json 里指向另一种 kind 的字段）
const swept = sweepLeftovers();
if (swept) console.log(`跨 kind 补扫: ${swept} 个文件`);

if (collisions.length) {
  console.log('\n撞名跳过:');
  for (const c of collisions) console.log('  ' + c);
}
