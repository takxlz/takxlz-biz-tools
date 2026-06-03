#!/usr/bin/env node
'use strict';

// Excel（1シート）から各テーブルのデータを読み取り、ローカル Oracle へ INSERT する。
// シートには複数テーブルのブロックが縦に並ぶ。各ブロックは次の並びで、空行で区切られる:
//   1行目: SELECT 文（ここからテーブル名を抽出する。例: select * from scott.emp where ...）
//   2行目: ヘッダ行（= カラム名。ヘッダ名とテーブルのカラム名は一致する前提）
//   3行目以降: データ行（空行が来たらブロック終了）
// 値は全て文字列でバインドし、Oracle の暗黙変換に任せる（NUMBER は問題なし。DATE は
//   セッションの NLS 書式に依存するため、必要なら投入前に ALTER SESSION で書式を合わせる）。
// XMLType カラムは文字列を直接 INSERT できないため、DB メタデータ（all_tab_columns）で
//   XMLType 列を特定し、その列だけ INSERT 文で XMLTYPE(:bind) でラップする。
// 接続は node-oracledb の Thin モード（Instant Client 不要、Oracle 12.1 以降）。
// データの出力先は Oracle（標準出力は使わない）。投入結果サマリ（テーブル別件数・合計）は
//   標準エラーへ出す（-q で抑制）。stdout=データ / stderr=メタ の方針に合わせている。
//
// パース・SQL 生成（extractTableName / parseSheetBlocks / buildInsertSql）は DB・Excel に
// 依存しない純関数で、単体テスト対象。DB/Excel を触る関数は oracledb / exceljs を
// 遅延 require しており、それらが未インストールでも純関数のテストは実行できる。

const { parseArgs } = require('node:util');

const USAGE = `使い方: node excel-to-oracle.js <Excelファイル> [options]

  <Excelファイル>  投入対象の .xlsx（1シートに複数テーブルのブロックが縦に並ぶ）

オプション:
  -q, --quiet  標準エラーへの投入結果サマリを抑制する
  -h, --help   この使い方を表示

接続情報は環境変数で渡す: ORA_USER / ORA_PASSWORD / ORA_CONNECT_STRING
データは Oracle へ INSERT する（標準出力は使わない）。
`;

/**
 * SELECT 文からテーブル名を抽出する。`from` 直後の最初の識別子を採用し、
 * `schema.table` 形式はそのまま返す。識別子のダブルクォートは取り除く。
 *
 * @param {string} selectSql SELECT 文（例: "select * from scott.emp e where ..."）
 * @returns {string} テーブル名（例: "scott.emp"）
 * @throws {Error} from 句が見つからずテーブル名を抽出できない場合
 */
function extractTableName(selectSql) {
  // from の次の、空白・カンマ・セミコロン・括弧で区切られる最初のトークンを取る
  const match = /\bfrom\s+([^\s,;()]+)/i.exec(String(selectSql));
  if (match === null) {
    throw new Error(`SELECT 文からテーブル名を抽出できません: ${selectSql}`);
  }
  return match[1].replace(/"/g, '');
}

/**
 * セルが空（未定義・null・空白のみ）かどうかを判定する。
 *
 * @param {*} cell セル値
 * @returns {boolean} 空なら true
 */
function isBlankCell(cell) {
  return cell === undefined || cell === null || String(cell).trim() === '';
}

/**
 * 行全体が空（セルが無い、または全セルが空）かどうかを判定する。ブロックの区切り判定に使う。
 *
 * @param {Array<*>} row 行（セル配列）
 * @returns {boolean} 空行なら true
 */
function isBlankRow(row) {
  return !Array.isArray(row) || row.length === 0 || row.every(isBlankCell);
}

/**
 * 行が SELECT 文の行かどうかを判定する。セルを空白で連結した文字列が select で始まれば真。
 *
 * @param {Array<*>} row 行（セル配列）
 * @returns {boolean} SELECT 行なら true
 */
function isSelectRow(row) {
  return /^\s*select\b/i.test(rowToText(row));
}

/**
 * 行のセルを空白区切りで連結し、トリムした文字列を返す。SELECT 文の復元に使う。
 *
 * @param {Array<*>} row 行（セル配列）
 * @returns {string} 連結したテキスト
 */
function rowToText(row) {
  if (!Array.isArray(row)) {
    return '';
  }
  return row
    .map((cell) => (cell === undefined || cell === null ? '' : String(cell)))
    .join(' ')
    .trim();
}

/**
 * ヘッダ行末尾の空セルを取り除いたカラム名配列を返す（各セルはトリムする）。
 *
 * @param {Array<*>} headerRow ヘッダ行（セル配列）
 * @returns {string[]} カラム名配列
 */
function toColumns(headerRow) {
  const columns = headerRow.map((cell) => String(cell ?? '').trim());
  // 末尾の空カラムは列数に数えない
  while (columns.length > 0 && columns[columns.length - 1] === '') {
    columns.pop();
  }
  return columns;
}

/**
 * シート全体（2次元配列）を、テーブルごとのブロックに分割する。
 * 「SELECT 行 → ヘッダ行 → データ行（空行まで）」を1ブロックとし、空行で区切る。
 * SELECT 行の直後が空行など、ヘッダを取れないブロックは破棄する。
 *
 * @param {Array<Array<*>>} rows シートの全行（各行はセル配列）
 * @returns {Array<{tableName: string, columns: string[], rows: Array<Array<*>>}>}
 *   ブロックの配列。columns はカラム名、rows は各データ行（生のセル配列）。
 */
function parseSheetBlocks(rows) {
  const blocks = [];
  let current = null;
  // 'idle'=SELECT 待ち / 'expectHeader'=ヘッダ待ち / 'data'=データ行収集中
  let state = 'idle';

  const closeCurrent = () => {
    // ヘッダまで取れているブロックのみ確定する
    if (current !== null && current.columns.length > 0) {
      blocks.push(current);
    }
    current = null;
    state = 'idle';
  };

  for (const row of rows) {
    if (isBlankRow(row)) {
      closeCurrent();
      continue;
    }

    if (state === 'idle') {
      // SELECT 行のみブロック開始の起点とする。それ以外の非空行（表題など）は読み飛ばす
      if (isSelectRow(row)) {
        current = { tableName: extractTableName(rowToText(row)), columns: [], rows: [] };
        state = 'expectHeader';
      }
      continue;
    }

    if (state === 'expectHeader') {
      current.columns = toColumns(row);
      state = 'data';
      continue;
    }

    // state === 'data'
    current.rows.push(row);
  }

  closeCurrent();
  return blocks;
}

/**
 * INSERT 文を生成する。XMLType 列はバインドを XMLTYPE() でラップする。
 * バインドは位置指定（:1, :2, ...）で、カラムの並び順に対応する。
 *
 * @param {string} tableName テーブル名
 * @param {string[]} columns カラム名（並び順がバインド順）
 * @param {string[]} [xmlTypeColumns=[]] XMLType のカラム名一覧（大小文字は無視して照合）
 * @returns {string} INSERT 文
 */
function buildInsertSql(tableName, columns, xmlTypeColumns = []) {
  const xmlSet = new Set(Array.from(xmlTypeColumns, (col) => String(col).toUpperCase()));
  const columnList = columns.join(', ');
  const placeholders = columns
    .map((col, index) => {
      const bind = `:${index + 1}`;
      return xmlSet.has(col.toUpperCase()) ? `XMLTYPE(${bind})` : bind;
    })
    .join(', ');
  return `INSERT INTO ${tableName} (${columnList}) VALUES (${placeholders})`;
}

/**
 * データ行を、INSERT のバインド配列（位置指定）へ変換する。
 * カラム数に合わせて切り出し、空セルは NULL（null）にする。それ以外は文字列化する。
 *
 * @param {Array<*>} row データ行（生のセル配列）
 * @param {number} columnCount カラム数
 * @returns {Array<string|null>} バインド値の配列
 */
function toBindRow(row, columnCount) {
  const binds = [];
  for (let index = 0; index < columnCount; index += 1) {
    const cell = row[index];
    binds.push(isBlankCell(cell) ? null : String(cell));
  }
  return binds;
}

/**
 * Excel ファイルの先頭シートを2次元配列（行×セル、各セルは表示文字列）で読み取る。
 * 空行もブロック区切りとして必要なため保持する。
 *
 * @param {string} filePath Excel ファイルのパス
 * @returns {Promise<Array<Array<string>>>} シートの全行
 * @throws {Error} シートが存在しない場合
 */
async function readWorkbook(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new Error('シートが見つかりません');
  }

  const rows = [];
  const columnCount = worksheet.columnCount;
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    for (let column = 1; column <= columnCount; column += 1) {
      // .text はセルの表示文字列（数式の結果や日付の表示値も文字列で得られる）
      cells.push(row.getCell(column).text ?? '');
    }
    rows.push(cells);
  });
  return rows;
}

/**
 * テーブルの XMLType カラム名一覧を DB メタデータ（all_tab_columns）から取得する。
 * テーブル名は大文字に正規化して照合する（`schema.table` は owner も絞り込む）。
 *
 * @param {object} connection node-oracledb の接続
 * @param {string} tableName テーブル名（schema.table 可）
 * @returns {Promise<string[]>} XMLType カラム名（大文字）の配列
 */
async function getXmlTypeColumns(connection, tableName) {
  const oracledb = require('oracledb');
  const parts = tableName.replace(/"/g, '').split('.');
  const binds = {};
  let sql =
    "SELECT column_name FROM all_tab_columns WHERE table_name = :tableName AND data_type = 'XMLTYPE'";

  if (parts.length === 2) {
    binds.owner = parts[0].toUpperCase();
    binds.tableName = parts[1].toUpperCase();
    sql += ' AND owner = :owner';
  } else {
    binds.tableName = parts[0].toUpperCase();
  }

  const result = await connection.execute(sql, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
  return result.rows.map((row) => row.COLUMN_NAME);
}

/**
 * ブロックごとに XMLType 列を判定し、INSERT 文を組み立てて executeMany で投入する。
 * 全ブロックの投入後にまとめてコミットする（途中失敗時はコミットしない）。
 * データ行が無いブロックはスキップする。
 *
 * @param {object} connection node-oracledb の接続
 * @param {Array<{tableName: string, columns: string[], rows: Array<Array<*>>}>} blocks
 *   parseSheetBlocks の結果
 * @returns {Promise<Array<{tableName: string, inserted: number, skipped?: boolean}>>}
 *   テーブルごとの投入件数
 */
async function insertBlocks(connection, blocks) {
  const results = [];

  for (const block of blocks) {
    if (block.rows.length === 0) {
      results.push({ tableName: block.tableName, inserted: 0, skipped: true });
      continue;
    }

    const xmlTypeColumns = await getXmlTypeColumns(connection, block.tableName);
    const sql = buildInsertSql(block.tableName, block.columns, xmlTypeColumns);
    const binds = block.rows.map((row) => toBindRow(row, block.columns.length));

    const result = await connection.executeMany(sql, binds, { autoCommit: false });
    results.push({ tableName: block.tableName, inserted: result.rowsAffected ?? binds.length });
  }

  await connection.commit();
  return results;
}

/**
 * CLI エントリポイント。
 * 使い方: node excel-to-oracle.js <Excelファイル> [-q]
 * 接続情報は環境変数で渡す: ORA_USER / ORA_PASSWORD / ORA_CONNECT_STRING
 */
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
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

  const [excelPath] = parsed.positionals;
  if (excelPath === undefined) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const quiet = parsed.values.quiet;

  const { ORA_USER, ORA_PASSWORD, ORA_CONNECT_STRING } = process.env;
  if (!ORA_USER || !ORA_PASSWORD || !ORA_CONNECT_STRING) {
    process.stderr.write(
      '環境変数が不足しています: ORA_USER / ORA_PASSWORD / ORA_CONNECT_STRING\n'
    );
    process.exit(1);
  }

  const oracledb = require('oracledb');
  let connection;
  try {
    const rows = await readWorkbook(excelPath);
    const blocks = parseSheetBlocks(rows);

    connection = await oracledb.getConnection({
      user: ORA_USER,
      password: ORA_PASSWORD,
      connectString: ORA_CONNECT_STRING,
    });

    const results = await insertBlocks(connection, blocks);
    // 投入結果はメタ情報なので標準エラーへ（標準出力はデータ専用に空けておく）
    let totalInserted = 0;
    for (const result of results) {
      totalInserted += result.inserted;
      if (!quiet) {
        const suffix = result.skipped ? '（データ行なし・スキップ）' : '';
        process.stderr.write(`  ${result.tableName}: ${result.inserted} 件${suffix}\n`);
      }
    }
    if (!quiet) {
      process.stderr.write(
        `excel-to-oracle: ${results.length} テーブル / 計 ${totalInserted} 件 INSERT\n`
      );
    }
  } catch (err) {
    // 内部情報を晒さないため、ユーザー向けはメッセージのみ
    process.stderr.write(`処理に失敗しました: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    if (connection !== undefined) {
      await connection.close();
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractTableName,
  isBlankCell,
  isBlankRow,
  isSelectRow,
  rowToText,
  toColumns,
  parseSheetBlocks,
  buildInsertSql,
  toBindRow,
  readWorkbook,
  getXmlTypeColumns,
  insertBlocks,
};
