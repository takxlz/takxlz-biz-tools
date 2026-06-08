#!/usr/bin/env node
'use strict';

// TSV の指定列（ファイルパス）が、与えたファイル名リストに後方一致するか検査し、
// 一致した行の末尾に印（●）の列を追加して標準出力へ書き出す。
// 判定対象の列は --match-col で指定する（ヘッダ名 or 1始まりの列番号）。
//   既定は最左列。列名・列数には依存しないため、任意の TSV に使える。
// 判定: 対象列パスの basename（/ と \ の両区切りに対応）が、リストのいずれかと完全一致。
//       myapp.properties は app.properties に一致しない（部分一致では拾わない）。
// 出力: 元の列はそのまま保持し、最右に新規列を1つ追加する。
//       ヘッダ名は既定で "match"（--header で変更可）、一致行は ●（--mark で変更可）、非一致行は空セル。
//       既定で標準出力、--out 指定時はファイルへ（その場合 stdout は沈黙）。
//       件数サマリ（読込/一致）は標準エラーへ1行出す（-q で抑制）。
// 前提: 1行目はヘッダ。セル内にタブ/改行を含まないプレーンな TSV。
// 大きめの入力を想定し、CLI では readline で1行ずつ処理する（全行をメモリに展開しない）。

const fs = require('node:fs');
const readline = require('node:readline');
const { parseArgs } = require('node:util');

const DEFAULT_COLUMN_HEADER = 'match';
const DEFAULT_MARK = '●';

/**
 * ファイルパスの basename（末尾要素）を返す。/ と \ の両方を区切りとして扱う。
 *
 * @param {string} filePath ファイルパス
 * @returns {string} 末尾のファイル名
 */
function getBaseName(filePath) {
  const segments = filePath.split(/[/\\]/);
  return segments[segments.length - 1];
}

/**
 * 1行1ファイル名のテキストを、ファイル名の配列に変換する。
 * 各行は前後空白をトリムし、空行は除外する。
 *
 * @param {string} listText リストファイルの内容
 * @returns {string[]} ファイル名の配列
 */
function parseFileList(listText) {
  return listText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * マッチ対象列の 0始まりインデックスを解決する。
 * 指定はヘッダ名・1始まりの列番号の両対応で、ヘッダ名一致を優先する。
 * 未指定（undefined / 空文字）の場合は最左列を対象とする。
 *
 * @param {string[]} headerCells ヘッダ行をタブ分割したセル配列
 * @param {string|number} [matchCol] ヘッダ名 または 1始まりの列番号
 * @returns {number} 0始まりの列インデックス
 * @throws {Error} ヘッダ名にも一致せず列番号としても無効な場合
 */
function resolveMatchColumnIndex(headerCells, matchCol) {
  if (matchCol === undefined || matchCol === null || matchCol === '') {
    return 0;
  }
  const spec = String(matchCol).trim();

  // 1) ヘッダ名一致を優先（数字のヘッダ名があれば列番号より名前を採る）
  const indexByName = headerCells.findIndex((cell) => cell.trim() === spec);
  if (indexByName !== -1) {
    return indexByName;
  }

  // 2) 1始まりの列番号として解釈
  if (/^\d+$/.test(spec)) {
    const oneBased = Number(spec);
    if (oneBased >= 1 && oneBased <= headerCells.length) {
      return oneBased - 1;
    }
    throw new Error(`列番号が範囲外です: ${spec}（1〜${headerCells.length}）`);
  }

  throw new Error(`マッチ対象列が見つかりません: "${spec}"（ヘッダ名にも一致せず列番号でもない）`);
}

/**
 * ヘッダ行の末尾に、印用の新規列ヘッダをタブ区切りで追加する。
 *
 * @param {string} headerLine ヘッダ行（タブ区切り）
 * @param {string} columnHeader 追加する列のヘッダ名
 * @returns {string} 列を追加したヘッダ行
 */
function markHeaderLine(headerLine, columnHeader) {
  return headerLine + '\t' + columnHeader;
}

/**
 * データ行の対象列（matchIndex）の basename がリストに一致するか判定し、
 * 末尾に印（一致時）または空セル（非一致時）を追加する。
 * 空行はそのまま返す（列を足さない）。
 *
 * @param {string} dataLine データ行（タブ区切り）
 * @param {Set<string>} fileNameSet 突き合わせ対象のファイル名集合
 * @param {string} mark 一致時に付ける印
 * @param {number} matchIndex 判定に使う列の 0始まりインデックス
 * @returns {string} 印または空セルを末尾に足した行（空行はそのまま）
 */
function markDataLine(dataLine, fileNameSet, mark, matchIndex) {
  if (dataLine === '') {
    return '';
  }
  const cells = dataLine.split('\t');
  // 対象列の値を前後空白を除いた basename で突き合わせる
  const fileValue = (cells[matchIndex] ?? '').trim();
  const matched = fileNameSet.has(getBaseName(fileValue));
  return dataLine + '\t' + (matched ? mark : '');
}

/**
 * TSV 文字列全体を処理して、印付き TSV 文字列を返す（インメモリ版）。
 * 先頭行をヘッダとして対象列を解決し列を追加、以降をデータ行として印付けする。
 * 入力末尾の改行は保持する。改行は LF に正規化する。
 *
 * @param {string} tsvText 入力 TSV の全文
 * @param {string[]} fileNames 突き合わせ対象のファイル名一覧
 * @param {object} [options]
 * @param {string|number} [options.matchCol] マッチ対象列（ヘッダ名 or 1始まり列番号、既定は最左列）
 * @param {string} [options.columnHeader='match'] 追加列のヘッダ名
 * @param {string} [options.mark='●'] 一致時に付ける印
 * @returns {string} 印付き TSV
 * @throws {Error} matchCol が解決できない場合
 */
function markMatches(tsvText, fileNames, options = {}) {
  const columnHeader = options.columnHeader ?? DEFAULT_COLUMN_HEADER;
  const mark = options.mark ?? DEFAULT_MARK;
  const fileNameSet = new Set(fileNames);

  const hadTrailingNewline = /\r?\n$/.test(tsvText);
  const lines = tsvText.split(/\r?\n/);
  if (hadTrailingNewline) {
    // 末尾改行による空要素を取り除く（再結合時に付け直す）
    lines.pop();
  }
  if (lines.length === 0) {
    return hadTrailingNewline ? '\n' : '';
  }

  const matchIndex = resolveMatchColumnIndex(lines[0].split('\t'), options.matchCol);
  const outLines = lines.map((line, index) =>
    index === 0 ? markHeaderLine(line, columnHeader) : markDataLine(line, fileNameSet, mark, matchIndex)
  );
  return outLines.join('\n') + (hadTrailingNewline ? '\n' : '');
}

/**
 * 入力 TSV ファイルを1行ずつ読み、印付き TSV を出力ストリームへ書き出す（ストリーム版）。
 * 大きめの入力でも全行をメモリに載せないため CLI ではこちらを使う。
 * 行単位の処理は markHeaderLine / markDataLine と共通。
 *
 * @param {string} inputPath 入力 TSV のパス（'-' で標準入力から読む）
 * @param {Set<string>} fileNameSet 突き合わせ対象のファイル名集合
 * @param {NodeJS.WritableStream} outStream 出力先ストリーム
 * @param {object} [options]
 * @param {string|number} [options.matchCol] マッチ対象列（ヘッダ名 or 1始まり列番号、既定は最左列）
 * @param {string} [options.columnHeader='match'] 追加列のヘッダ名
 * @param {string} [options.mark='●'] 一致時に付ける印
 * @returns {Promise<{rowCount: number, matchedCount: number}>}
 *   rowCount は処理したデータ行数（ヘッダ・空行を除く）、matchedCount は一致した行数。stderr サマリ用。
 * @throws {Error} matchCol が解決できない場合
 */
async function markMatchesStream(inputPath, fileNameSet, outStream, options = {}) {
  const columnHeader = options.columnHeader ?? DEFAULT_COLUMN_HEADER;
  const mark = options.mark ?? DEFAULT_MARK;

  // '-' は標準入力。stdin は共有リソースなので破棄しない（後段の finally 参照）
  const readingStdin = inputPath === '-';
  const inputStream = readingStdin
    ? process.stdin.setEncoding('utf8')
    : fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lineReader = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

  let isHeader = true;
  let matchIndex = -1;
  let rowCount = 0;
  let matchedCount = 0;
  try {
    for await (const line of lineReader) {
      let outLine;
      if (isHeader) {
        matchIndex = resolveMatchColumnIndex(line.split('\t'), options.matchCol);
        outLine = markHeaderLine(line, columnHeader);
        isHeader = false;
      } else {
        if (line !== '') {
          // 件数集計。markDataLine 内の判定と同条件で別途数える（mark を空にしても壊れないよう出力文字列には依存しない）
          rowCount++;
          const fileValue = (line.split('\t')[matchIndex] ?? '').trim();
          if (fileNameSet.has(getBaseName(fileValue))) {
            matchedCount++;
          }
        }
        outLine = markDataLine(line, fileNameSet, mark, matchIndex);
      }
      outStream.write(outLine + '\n');
    }
  } finally {
    lineReader.close();
    if (!readingStdin) {
      inputStream.destroy();
    }
  }

  return { rowCount, matchedCount };
}

const USAGE = `使い方: node tsv-mark-matches.js <入力TSV|-> <ファイル名リスト> [options]

  <入力TSV|->         入力TSV のパス。- で標準入力から読む
  <ファイル名リスト>  1行1ファイル名のテキスト

オプション:
  -c, --match-col <名前|番号>  マッチ対象列（ヘッダ名 or 1始まり列番号、既定は最左列）
  -m, --mark <印>              一致時に付ける印（既定 ●）
  -H, --header <名前>          追加する列のヘッダ名（既定 match）
  -o, --out <file>             結果をファイルへ書き出す（指定時は標準出力に出さない）
  -q, --quiet                  標準エラーへのサマリを抑制する
  -h, --help                   この使い方を表示

結果データは標準出力（既定）または --out のファイルへ。
件数サマリは標準エラーへ1行出す（-q で抑制）。
`;

/**
 * CLI エントリポイント。
 */
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'match-col': { type: 'string', short: 'c' },
        mark: { type: 'string', short: 'm' },
        header: { type: 'string', short: 'H' },
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

  const [inputPath, listPath] = parsed.positionals;
  const matchCol = parsed.values['match-col'];
  // mark / columnHeader は未指定（undefined）なら markMatchesStream 側で既定（● / match）に解決される
  const mark = parsed.values.mark;
  const columnHeader = parsed.values.header;
  const outPath = parsed.values.out;

  if (inputPath === undefined || listPath === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  try {
    const fileNameSet = new Set(parseFileList(fs.readFileSync(listPath, 'utf8')));
    // --out 指定時はファイルへ。stdout は沈黙させ、トークン消費・パイプ汚染を避ける
    const outStream = outPath !== undefined ? fs.createWriteStream(outPath) : process.stdout;
    const stats = await markMatchesStream(inputPath, fileNameSet, outStream, {
      matchCol,
      mark,
      columnHeader,
    });
    // ファイルストリームは終了まで待つ（stdout は共有なので閉じない）
    if (outPath !== undefined) {
      await new Promise((resolve, reject) => {
        outStream.on('error', reject);
        outStream.end(resolve);
      });
    }
    if (!parsed.values.quiet) {
      const dest = outPath !== undefined ? outPath : 'stdout';
      process.stderr.write(
        `tsv-mark-matches: 読込 ${stats.rowCount} 行 → 一致 ${stats.matchedCount} 行 → ${dest}\n`
      );
    }
  } catch (err) {
    process.stderr.write(`処理に失敗しました: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getBaseName,
  parseFileList,
  resolveMatchColumnIndex,
  markHeaderLine,
  markDataLine,
  markMatches,
  markMatchesStream,
};
