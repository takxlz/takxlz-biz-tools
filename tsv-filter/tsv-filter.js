#!/usr/bin/env node
'use strict';

// 指定した列の値が指定文字列と一致する行を除外する汎用 TSV フィルタ。
// 列はヘッダー名または 1 始まりの列番号で指定する（cut/awk と同じ流儀）。
// 入力はファイル引数または標準入力（省略 / -）。
// 出力は既定で標準出力、--out 指定時はファイルへ（その場合 stdout は沈黙）。
// 件数サマリ（読込/出力/除外）は標準エラーへ1行出す（-q で抑制）。

const fs = require('fs');
const { parseArgs } = require('node:util');

/**
 * ヘッダー行から、除外判定に使う列のインデックスを解決する。
 * ヘッダー名での一致を優先し、見つからなければ数値をインデックスとして扱う。
 *
 * @param {string[]} headerCells ヘッダー行をタブ分割したセル配列
 * @param {string} columnSpec 列の指定（ヘッダー名 または 1 始まりの列番号文字列）
 * @returns {number} 0 始まりの列インデックス
 * @throws {Error} 列名が見つからない、または列番号が範囲外の場合
 */
function resolveColumnIndex(headerCells, columnSpec) {
  // ヘッダー名で一致（前後空白はトリムして比較）
  const nameMatchIndex = headerCells.findIndex((headerCell) => headerCell.trim() === columnSpec);
  if (nameMatchIndex !== -1) {
    return nameMatchIndex;
  }
  // 数値なら 1 始まりの列番号として扱う（cut/awk と同じ流儀）
  if (/^\d+$/.test(columnSpec)) {
    const columnNumber = Number(columnSpec);
    if (columnNumber >= 1 && columnNumber <= headerCells.length) {
      return columnNumber - 1;
    }
  }
  throw new Error(`列が見つかりません: ${columnSpec}`);
}

/**
 * TSV 文字列から、指定列の値が除外値と一致する行を除いた TSV と件数を返す。
 * ヘッダー行は常に保持し、空行はスキップする。件数（read/kept/excluded）は
 * データ行のみを数える（ヘッダー・空行は含めない）。stderr サマリ用。
 *
 * @param {string} content TSV 全文（タブ区切り、改行は LF / CRLF 両対応）
 * @param {string} columnSpec 除外判定する列（ヘッダー名 または 1 始まりの列番号文字列）
 * @param {string} excludeValue 除外する値（列の値を前後トリムして完全一致で比較）
 * @returns {{tsv: string, read: number, kept: number, excluded: number}}
 *   tsv は除外後の TSV（末尾改行なし。入力が空なら空文字）。read/kept/excluded はデータ行の件数。
 * @throws {Error} 指定した列がヘッダーに見つからない場合
 */
function filterTsv(content, columnSpec, excludeValue) {
  // CRLF / LF 両対応で行分割
  const lines = content.split(/\r?\n/);

  // 先頭の空行を読み飛ばしてヘッダーを探す
  let headerIndex = 0;
  while (headerIndex < lines.length && lines[headerIndex] === '') {
    headerIndex++;
  }
  if (headerIndex >= lines.length) {
    return { tsv: '', read: 0, kept: 0, excluded: 0 };
  }

  const header = lines[headerIndex];
  const columnIndex = resolveColumnIndex(header.split('\t'), columnSpec);

  const outputLines = [header];
  let read = 0;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      // 空行はスキップ（件数にも数えない）
      continue;
    }
    read++;
    const cellValue = (line.split('\t')[columnIndex] ?? '').trim();
    if (cellValue !== excludeValue) {
      outputLines.push(line);
    }
  }

  const kept = outputLines.length - 1; // ヘッダー分を引く
  return { tsv: outputLines.join('\n'), read, kept, excluded: read - kept };
}

const USAGE = `使い方: node tsv-filter.js <列> <除外する値> [入力TSV] [options]

  <列>          除外判定する列。ヘッダー名 or 1始まりの列番号
  <除外する値>  その列がこの値の行を除外（前後空白をトリムして完全一致で比較）
  [入力TSV]     入力TSV のパス。省略 または - で標準入力から読む

オプション:
  -o, --out <file>  結果をファイルへ書き出す（指定時は標準出力に出さない）
  -q, --quiet       標準エラーへのサマリを抑制する
  -h, --help        この使い方を表示

結果データは標準出力（既定）または --out のファイルへ。
件数サマリは標準エラーへ1行出す（-q で抑制）。
`;

/**
 * CLI エントリポイント。
 */
function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`引数エラー: ${err.message}\n${USAGE}`);
    process.exit(1);
  }

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const [columnSpec, excludeValue, inputPath] = parsed.positionals;

  if (columnSpec === undefined || excludeValue === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  let content;
  try {
    // パス未指定 or - なら標準入力(fd:0)から読む
    const inputSource = inputPath === undefined || inputPath === '-' ? 0 : inputPath;
    content = fs.readFileSync(inputSource, 'utf8');
  } catch (err) {
    process.stderr.write(`入力の読み込みに失敗しました: ${err.message}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = filterTsv(content, columnSpec, excludeValue);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  // 出力がある場合のみ末尾に改行を付与
  const data = result.tsv ? result.tsv + '\n' : '';
  const outPath = parsed.values.out;
  if (outPath !== undefined) {
    // --out 指定時はファイルへ。stdout は沈黙させ、トークン消費・パイプ汚染を避ける
    fs.writeFileSync(outPath, data);
  } else {
    process.stdout.write(data);
  }

  if (!parsed.values.quiet) {
    const dest = outPath !== undefined ? outPath : 'stdout';
    process.stderr.write(
      `tsv-filter: 読込 ${result.read} 行 → 出力 ${result.kept} 行` +
        `（除外 ${result.excluded}: ${columnSpec}=${excludeValue}）→ ${dest}\n`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { filterTsv, resolveColumnIndex };
