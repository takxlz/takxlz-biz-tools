'use strict';

// テスト名を仕様文として読めるようにしている（入力条件 → 期待結果）。
// 各テスト本体は「準備 → 実行 → 検証(assert)」の順。非自明な意図のみコメントで補う。
// 対象は DB・Excel に依存しない純関数（パース / SQL 生成 / バインド変換）。
// DB/Excel 依存部（readWorkbook / getXmlTypeColumns / insertBlocks）は実 Oracle が要るため
// ここでは検証せず、手動確認とする（README 参照）。

const { test } = require('node:test');
const assert = require('node:assert');

const {
  extractTableName,
  isBlankCell,
  isBlankRow,
  isSelectRow,
  toColumns,
  parseSheetBlocks,
  buildInsertSql,
  toBindRow,
} = require('./excel-to-oracle');

// ---- extractTableName: SELECT 文からテーブル名を取り出す ---------------------

test('extractTableName: 単純な select * from <table> where ... を抽出する', () => {
  assert.strictEqual(extractTableName('select * from xxxx where a = 1'), 'xxxx');
});

test('extractTableName: schema.table 形式はスキーマ付きで返す', () => {
  assert.strictEqual(extractTableName('SELECT a, b FROM scott.emp e WHERE x > 0'), 'scott.emp');
});

test('extractTableName: 大文字 FROM・テーブル別名があっても先頭の識別子を取る', () => {
  assert.strictEqual(extractTableName('select * FROM employees emp'), 'employees');
});

test('extractTableName: ダブルクォート付き識別子はクォートを除去して返す', () => {
  assert.strictEqual(extractTableName('select * from "MyTab"'), 'MyTab');
});

test('extractTableName: セミコロンや括弧の直前で区切る', () => {
  assert.strictEqual(extractTableName('select * from dept;'), 'dept');
});

test('extractTableName: from 句が無ければ例外を投げる', () => {
  assert.throws(() => extractTableName('select 1 dual'), /テーブル名を抽出できません/);
});

// ---- isBlankCell / isBlankRow: 空判定（ブロック区切りの基礎） -----------------

test('isBlankCell: 未定義・null・空白のみは空とみなす', () => {
  assert.strictEqual(isBlankCell(undefined), true);
  assert.strictEqual(isBlankCell(null), true);
  assert.strictEqual(isBlankCell('   '), true);
});

test('isBlankCell: 値があれば空ではない（数値 0 や文字も含む）', () => {
  assert.strictEqual(isBlankCell('a'), false);
  assert.strictEqual(isBlankCell(0), false);
});

test('isBlankRow: 空配列・全セル空は空行とみなす', () => {
  assert.strictEqual(isBlankRow([]), true);
  assert.strictEqual(isBlankRow(['', '  ', null]), true);
});

test('isBlankRow: 1つでも値があれば空行ではない', () => {
  assert.strictEqual(isBlankRow(['', 'x', '']), false);
});

// ---- isSelectRow: SELECT 行の判定 --------------------------------------------

test('isSelectRow: select で始まる行は真（大小文字・前置空白を無視）', () => {
  assert.strictEqual(isSelectRow(['  SELECT * from t']), true);
});

test('isSelectRow: ヘッダ行やデータ行は偽', () => {
  assert.strictEqual(isSelectRow(['id', 'name']), false);
});

// ---- toColumns: ヘッダ行 → カラム名（末尾空セルを除去・トリム） ---------------

test('toColumns: 各セルをトリムし、末尾の空セルを切り落とす', () => {
  assert.deepStrictEqual(toColumns([' id ', 'name', '', '']), ['id', 'name']);
});

test('toColumns: 中間の空セルは残す（末尾のみ除去）', () => {
  assert.deepStrictEqual(toColumns(['id', '', 'bio', '']), ['id', '', 'bio']);
});

// ---- parseSheetBlocks: シート2次元配列 → テーブルブロック群 -------------------

test('parseSheetBlocks: 空行区切りの複数ブロックを、各テーブルに分割する', () => {
  // SELECT 行 → ヘッダ → データ2行 / 空行 / SELECT 行 → ヘッダ → データ1行
  const rows = [
    ['select * from emp where deptno = 10'],
    ['id', 'name', 'bio'],
    ['1', 'alice', '<b>hi</b>'],
    ['2', 'bob', ''],
    [],
    ['select * from dept'],
    ['id', 'label'],
    ['10', 'sales'],
  ];

  const blocks = parseSheetBlocks(rows);

  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks[0].tableName, 'emp');
  assert.deepStrictEqual(blocks[0].columns, ['id', 'name', 'bio']);
  assert.strictEqual(blocks[0].rows.length, 2);
  assert.deepStrictEqual(blocks[1].tableName, 'dept');
  assert.deepStrictEqual(blocks[1].columns, ['id', 'label']);
  assert.strictEqual(blocks[1].rows.length, 1);
});

test('parseSheetBlocks: 末尾に空行が続いても最後のブロックを取りこぼさない', () => {
  const rows = [
    ['select * from t'],
    ['a', 'b'],
    ['1', '2'],
    [],
    [],
  ];

  const blocks = parseSheetBlocks(rows);

  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].rows.length, 1);
});

test('parseSheetBlocks: 連続する空行は1つの区切りとして扱う', () => {
  const rows = [
    ['select * from a'],
    ['x'],
    ['1'],
    [],
    [],
    ['select * from b'],
    ['y'],
    ['2'],
  ];

  const blocks = parseSheetBlocks(rows);

  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual([blocks[0].tableName, blocks[1].tableName], ['a', 'b']);
});

test('parseSheetBlocks: SELECT 前の表題など非空行は読み飛ばす', () => {
  const rows = [
    ['# このシートはテスト用データです'],
    [],
    ['select * from t'],
    ['a'],
    ['1'],
  ];

  const blocks = parseSheetBlocks(rows);

  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].tableName, 't');
});

test('parseSheetBlocks: データ行が無いブロック（SELECT+ヘッダのみ）も保持する', () => {
  const rows = [
    ['select * from t'],
    ['a', 'b'],
  ];

  const blocks = parseSheetBlocks(rows);

  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].rows.length, 0);
});

// ---- buildInsertSql: INSERT 文生成（XMLType 列のラップ） ----------------------

test('buildInsertSql: 通常列のみは位置バインド(:1, :2, ...)を並べる', () => {
  assert.strictEqual(
    buildInsertSql('emp', ['id', 'name']),
    'INSERT INTO emp (id, name) VALUES (:1, :2)'
  );
});

test('buildInsertSql: XMLType 列はバインドを XMLTYPE() でラップする', () => {
  assert.strictEqual(
    buildInsertSql('doc', ['id', 'body'], ['BODY']),
    'INSERT INTO doc (id, body) VALUES (:1, XMLTYPE(:2))'
  );
});

test('buildInsertSql: XMLType 列の照合は大小文字を無視する', () => {
  // メタデータは大文字、ヘッダは小文字でも一致させる
  assert.strictEqual(
    buildInsertSql('doc', ['Id', 'Body'], ['body']),
    'INSERT INTO doc (Id, Body) VALUES (:1, XMLTYPE(:2))'
  );
});

test('buildInsertSql: schema.table と複数 XMLType 列に対応する', () => {
  assert.strictEqual(
    buildInsertSql('app.doc', ['id', 'x1', 'x2'], ['X1', 'X2']),
    'INSERT INTO app.doc (id, x1, x2) VALUES (:1, XMLTYPE(:2), XMLTYPE(:3))'
  );
});

// ---- toBindRow: データ行 → バインド配列（空セルは NULL） ----------------------

test('toBindRow: カラム数ぶん取り出し、空セルは null にする', () => {
  assert.deepStrictEqual(toBindRow(['1', '', 'x'], 3), ['1', null, 'x']);
});

test('toBindRow: 不足セルは null で補い、余剰セルは切り捨てる', () => {
  assert.deepStrictEqual(toBindRow(['1'], 3), ['1', null, null]);
  assert.deepStrictEqual(toBindRow(['1', '2', '3', '4'], 2), ['1', '2']);
});

test('toBindRow: 数値セルも文字列化する（全て文字列バインド方針）', () => {
  assert.deepStrictEqual(toBindRow([1, 2], 2), ['1', '2']);
});
