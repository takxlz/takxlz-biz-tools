#!/usr/bin/env node
'use strict';

// TSV から Java の .properties を環境ごとに生成する。
// TSV 列: file, key, 種別, <env名×N>, description
//   - file        … 出力プロパティファイル名（<file>.properties）
//   - key         … プロパティのキー
//   - 種別        … 生成には未使用（読み飛ばす）
//   - <env名×N>   … 環境ごとの値。ヘッダのこの列名がそのまま出力ディレクトリ名になる
//   - description … キーの直前に付けるコメント
// 出力: <出力ルート>/<env名>/<file>.properties（データはファイル群へ。標準出力は使わない）
//   完了サマリ（読込行数 / 環境数 / 生成ファイル数）は標準エラーへ1行出す（-q で抑制）。
// 非ASCII（日本語など）は key/value/comment すべてで \uXXXX に変換する（native2ascii 相当）。
// 10万〜100万行を想定し、readline で1行ずつ処理する（全行をメモリに展開しない）。

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');

// env セルのセンチネル（実データには現れない前提の特別な値）。
//   <EMPTY>  … 明示的に空。`key=`（空文字）を出力する
//   <NOKEY>  … その環境にキーが存在しない（未設定）。行を出力しない
//   <NOPROP> … その環境にプロパティ自体が存在しない（適用外）。行を出力しない
// <NOKEY> と <NOPROP> は出力挙動は同じ（行を出さない）。TSV 上で意図を区別するためのラベル。
// 空セルはどれか不明なためエラーとする（入力側で必ず明示させる）。
const SENTINEL_EMPTY = '<EMPTY>';
const SENTINEL_NO_KEY = '<NOKEY>';
const SENTINEL_NO_PROP = '<NOPROP>';

/**
 * 1文字を Java properties 形式の \uXXXX エスケープに変換する。
 *
 * @param {number} charCode UTF-16 コードユニット
 * @returns {string} `\uXXXX`（16進4桁・大文字）
 */
function toUnicodeEscape(charCode) {
  return '\\u' + charCode.toString(16).padStart(4, '0').toUpperCase();
}

/**
 * キーまたは値を Java の properties 仕様に従ってエスケープする。
 * java.util.Properties#saveConvert と同じ規則。非ASCII は \uXXXX に変換する。
 *
 * @param {string} text 対象文字列
 * @param {boolean} escapeAllSpaces true ならすべての空白を、false なら先頭空白のみエスケープ（キー=true / 値=false）
 * @returns {string} エスケープ済み文字列
 */
function escapeProperty(text, escapeAllSpaces) {
  let escaped = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const charCode = text.charCodeAt(i);

    // '>'(62)〜'~'(126) はバックスラッシュ以外そのまま出力
    if (charCode > 61 && charCode < 127) {
      escaped += char === '\\' ? '\\\\' : char;
      continue;
    }

    switch (char) {
      case ' ':
        // キーは全空白、値は先頭空白のみエスケープ
        escaped += i === 0 || escapeAllSpaces ? '\\ ' : ' ';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\f':
        escaped += '\\f';
        break;
      case '=':
      case ':':
      case '#':
      case '!':
        escaped += '\\' + char;
        break;
      default:
        // 制御文字・非ASCII は \uXXXX に変換
        escaped += charCode < 0x20 || charCode > 0x7e ? toUnicodeEscape(charCode) : char;
    }
  }
  return escaped;
}

/**
 * properties のキーをエスケープする（全空白をエスケープ）。
 *
 * @param {string} key キー文字列
 * @returns {string} エスケープ済みキー
 */
function escapeKey(key) {
  return escapeProperty(key, true);
}

/**
 * properties の値をエスケープする（先頭空白のみエスケープ）。
 *
 * @param {string} propertyValue 値文字列
 * @returns {string} エスケープ済み値
 */
function escapeValue(propertyValue) {
  return escapeProperty(propertyValue, false);
}

/**
 * コメント文字列をエスケープする。改行は空白に潰し、非ASCII を \uXXXX に変換する。
 *
 * @param {string} comment コメント文字列
 * @returns {string} 1行に収めたエスケープ済みコメント
 */
function escapeComment(comment) {
  const singleLine = comment.replace(/[\r\n]+/g, ' ');
  let escaped = '';
  for (let i = 0; i < singleLine.length; i++) {
    const charCode = singleLine.charCodeAt(i);
    escaped += charCode < 0x20 || charCode > 0x7e ? toUnicodeEscape(charCode) : singleLine[i];
  }
  return escaped;
}

/**
 * ヘッダ行を解析し、環境名と各列インデックスを返す。
 * 列構成: file, key, 種別, <env名×N>, description（env は最低1つ必要）。
 *
 * @param {string} headerLine ヘッダ行（タブ区切り）
 * @returns {{envNames: string[], envStartIndex: number, descIndex: number}} 環境名配列と列位置
 * @throws {Error} env 列が1つも取れない（列が少なすぎる）場合
 */
function parseHeader(headerLine) {
  const cells = headerLine.split('\t');
  // file, key, 種別, env(>=1), description で最低5列
  if (cells.length < 5) {
    throw new Error(`ヘッダの列が不足しています（最低5列必要）: ${cells.length}列`);
  }
  const envStartIndex = 3;
  const descIndex = cells.length - 1;
  const envNames = cells.slice(envStartIndex, descIndex).map((name) => name.trim());
  return { envNames, envStartIndex, descIndex };
}

/**
 * 1キー分の出力テキスト（コメント行 + `key=value`）を組み立てる。
 * description が空の場合はコメント行を出さない。値が空でも `key=` を出力する。
 *
 * @param {string} key キー
 * @param {string} propertyValue 値（空文字可）
 * @param {string} description コメント（空文字可）
 * @returns {string} 末尾改行付きの出力テキスト
 */
function formatEntry(key, propertyValue, description) {
  let entry = '';
  if (description !== '') {
    entry += '#' + escapeComment(description) + '\n';
  }
  entry += escapeKey(key) + '=' + escapeValue(propertyValue) + '\n';
  return entry;
}

/**
 * env セルの値をセンチネル規約に従って解釈する。
 *   <EMPTY> → 空値で出力 / <NOKEY>・<NOPROP> → 出力しない / それ以外 → その値で出力。
 * 空セルはどれか判別できないためエラーとする。
 *
 * @param {string} rawCell env 列の生の値
 * @returns {{emit: boolean, value: string}} emit が false ならそのキーは出力しない
 * @throws {Error} 空セル（センチネル未指定）の場合
 */
function resolveEnvCell(rawCell) {
  if (rawCell === '') {
    throw new Error(
      `空セルは許可されていません（${SENTINEL_EMPTY} / ${SENTINEL_NO_KEY} / ${SENTINEL_NO_PROP} を指定）`
    );
  }
  // キーなし / プロパティなし は出力挙動が同じ（行を出さない）
  if (rawCell === SENTINEL_NO_KEY || rawCell === SENTINEL_NO_PROP) {
    return { emit: false, value: '' };
  }
  if (rawCell === SENTINEL_EMPTY) {
    return { emit: true, value: '' };
  }
  return { emit: true, value: rawCell };
}

/**
 * env ディレクトリ配下の出力ファイルパスを組み立てる。
 * file 値が `.properties` で終わらなければ拡張子を付与する。
 *
 * @param {string} rootDir 出力ルートディレクトリ
 * @param {string} envName 環境名（ディレクトリ名）
 * @param {string} fileValue file 列の値
 * @returns {string} 出力ファイルの絶対/相対パス
 */
function buildOutputPath(rootDir, envName, fileValue) {
  const fileName = fileValue.endsWith('.properties') ? fileValue : fileValue + '.properties';
  return path.join(rootDir, envName, fileName);
}

/**
 * 出力先ファイルのプールを作る。
 * 同時オープン数を maxOpenFiles に制限し、超過分は LRU でクローズする。
 * 同一パスへの初回オープンは truncate('w')、再オープンは追記('a')。
 * 書き込みはバッファに溜め、閾値超過・退避・クローズ時にまとめて書き出す。
 *
 * @param {object} [options]
 * @param {number} [options.maxOpenFiles=200] 同時に開くファイルディスクリプタの上限
 * @param {number} [options.flushThresholdChars=65536] バッファをフラッシュする文字数の閾値（出力は純ASCIIなので実バイト数とほぼ一致）
 * @returns {{write: (filePath: string, text: string) => void, closeAll: () => void, fileCount: () => number}}
 *   fileCount は退避後も含めた、これまでに開いた出力ファイルの種類数を返す。
 */
function createFilePool({ maxOpenFiles = 200, flushThresholdChars = 65536 } = {}) {
  // Map は挿入順を保つので、先頭を最古（LRU 退避対象）として扱う
  const openFiles = new Map(); // filePath -> { fd, buffer }
  const truncatedPaths = new Set(); // 一度でも 'w' で開いたパス

  function flush(entry) {
    if (entry.buffer.length > 0) {
      fs.writeSync(entry.fd, entry.buffer);
      entry.buffer = '';
    }
  }

  function evictUntilWithinLimit() {
    while (openFiles.size > maxOpenFiles) {
      const oldest = openFiles.entries().next().value;
      const [oldestPath, oldestEntry] = oldest;
      openFiles.delete(oldestPath);
      flush(oldestEntry);
      fs.closeSync(oldestEntry.fd);
    }
  }

  function write(filePath, text) {
    let entry = openFiles.get(filePath);
    if (entry) {
      // 最近使用したものとして末尾へ移動
      openFiles.delete(filePath);
    } else {
      const flag = truncatedPaths.has(filePath) ? 'a' : 'w';
      truncatedPaths.add(filePath);
      // file 列がサブディレクトリを含む場合に備え、親ディレクトリを保証してから開く
      // （openSync('w') はファイルは作るが中間ディレクトリは作らない）
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      entry = { fd: fs.openSync(filePath, flag), buffer: '' };
    }
    entry.buffer += text;
    if (entry.buffer.length >= flushThresholdChars) {
      flush(entry);
    }
    openFiles.set(filePath, entry);
    evictUntilWithinLimit();
  }

  function closeAll() {
    for (const entry of openFiles.values()) {
      flush(entry);
      fs.closeSync(entry.fd);
    }
    openFiles.clear();
  }

  // truncatedPaths は一度でも開いたパスを退避後も保持するので、生成ファイル種類数として使える
  function fileCount() {
    return truncatedPaths.size;
  }

  return { write, closeAll, fileCount };
}

/**
 * TSV を読み込み、環境ごとの .properties ファイルを生成する。
 *
 * @param {string} inputPath 入力 TSV のパス
 * @param {string} rootDir 出力ルートディレクトリ
 * @param {object} [options]
 * @param {number} [options.maxOpenFiles] 同時オープンファイル数の上限
 * @returns {Promise<{rowCount: number, envNames: string[], fileCount: number}>}
 *   処理したデータ行数・環境名一覧・生成した .properties ファイル種類数
 * @throws {Error} ヘッダが解析できない場合
 */
async function generatePropertiesFiles(inputPath, rootDir, options = {}) {
  const fileStream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const pool = createFilePool(options);

  let header = null;
  let envNames = [];
  let envStartIndex = 0;
  let descIndex = 0;
  let rowCount = 0;
  let lineNumber = 0;

  try {
    for await (const line of lineReader) {
      lineNumber++;
      if (line === '') {
        continue;
      }
      if (header === null) {
        header = parseHeader(line);
        envNames = header.envNames;
        envStartIndex = header.envStartIndex;
        descIndex = header.descIndex;
        // 出力ディレクトリは初回 write 時に親まで作成するため、ここでの事前作成は不要
        continue;
      }

      const cells = line.split('\t');
      // env 名と同じくファイル名も前後空白を除去（ファイル名の揺れを防ぐ）
      const fileValue = (cells[0] ?? '').trim();
      const key = cells[1] ?? '';
      // description は末尾列。タブを含む場合に備えて descIndex 以降を結合する
      const description = cells.length > descIndex ? cells.slice(descIndex).join('\t') : '';

      for (let i = 0; i < envNames.length; i++) {
        const rawCell = cells[envStartIndex + i] ?? '';
        let resolved;
        try {
          resolved = resolveEnvCell(rawCell);
        } catch (err) {
          throw new Error(`${lineNumber}行目 列「${envNames[i]}」: ${err.message}`);
        }
        // <NOKEY> / <NOPROP>: その環境にはキー自体を出力しない
        if (!resolved.emit) {
          continue;
        }
        const outputPath = buildOutputPath(rootDir, envNames[i], fileValue);
        pool.write(outputPath, formatEntry(key, resolved.value, description));
      }
      rowCount++;
    }
  } finally {
    // 出力 FD と入力ストリームを確実に解放する（I/O エラー時の FD リーク防止）
    pool.closeAll();
    lineReader.close();
    fileStream.destroy();
  }

  return { rowCount, envNames, fileCount: pool.fileCount() };
}

const USAGE = `使い方: node tsv-to-properties.js <入力TSV> <出力ルートDir> [options]

  <入力TSV>        入力TSV のパス
  <出力ルートDir>  生成した .properties の出力ルート

オプション:
  --max-open-files <n>  同時に開くファイル数の上限（既定 200）
  -q, --quiet           標準エラーへの完了サマリを抑制する
  -h, --help            この使い方を表示
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
        'max-open-files': { type: 'string' },
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

  const [inputPath, rootDir] = parsed.positionals;
  if (inputPath === undefined || rootDir === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const options = {};
  if (parsed.values['max-open-files'] !== undefined) {
    const maxOpenFiles = Number(parsed.values['max-open-files']);
    if (!Number.isInteger(maxOpenFiles) || maxOpenFiles < 1) {
      process.stderr.write('--max-open-files は1以上の整数で指定してください\n');
      process.exit(1);
    }
    options.maxOpenFiles = maxOpenFiles;
  }

  try {
    const { rowCount, envNames, fileCount } = await generatePropertiesFiles(
      inputPath,
      rootDir,
      options
    );
    if (!parsed.values.quiet) {
      process.stderr.write(
        `tsv-to-properties: 読込 ${rowCount} 行 → ${envNames.length} 環境 / ${fileCount} ファイル生成 → ${rootDir}\n`
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
  escapeProperty,
  escapeKey,
  escapeValue,
  escapeComment,
  parseHeader,
  formatEntry,
  buildOutputPath,
  resolveEnvCell,
  createFilePool,
  generatePropertiesFiles,
};
