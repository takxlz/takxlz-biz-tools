'use strict';

// テスト名を仕様文として読めるようにしている（入力条件 → 期待結果）。
// 各テスト本体は「準備 → 実行 → 検証(assert)」の順。非自明な意図のみコメントで補う。

const { test } = require('node:test');
const assert = require('node:assert');
const { filterTsv } = require('./tsv-filter.js');

const HEADER = 'file\tkey\t種別\tdescription';

// テスト用に1行分の TSV を組み立てる（file と 種別 以外は固定）
function row(file, type) {
  return `${file}\tk\t${type}\tdesc`;
}

test('filterTsv: 指定列（ヘッダ名）が指定値に一致する行を除外し、ヘッダは残す', () => {
  const input = [
    HEADER,
    row('a', '一致率(1.0)'),
    row('b', '一致率(0.9)'),
    row('c', '一部欠損'),
  ].join('\n');

  const out = filterTsv(input, '種別', '一致率(1.0)').tsv.split('\n');

  assert.strictEqual(out[0], HEADER, 'ヘッダーは保持される');
  assert.ok(!out.some((line) => line.startsWith('a\t')), '一致した行は除外される');
  assert.ok(out.some((line) => line.startsWith('b\t')));
  assert.ok(out.some((line) => line.startsWith('c\t')));
  assert.strictEqual(out.length, 3, 'ヘッダー + 残り2行');
});

test('filterTsv: 列を 1始まりの列番号で指定できる', () => {
  const input = [HEADER, row('a', 'X'), row('b', 'Y')].join('\n');

  const out = filterTsv(input, '3', 'X').tsv.split('\n'); // 3列目 = 種別

  assert.ok(!out.some((line) => line.startsWith('a\t')));
  assert.ok(out.some((line) => line.startsWith('b\t')));
});

test('filterTsv: 比較対象セルは前後空白をトリムしてから突き合わせる', () => {
  const input = [HEADER, row('a', ' X '), row('b', 'Y')].join('\n');

  const out = filterTsv(input, '種別', 'X').tsv.split('\n');

  assert.ok(!out.some((line) => line.startsWith('a\t')), '前後空白付きでも除外される');
  assert.ok(out.some((line) => line.startsWith('b\t')));
});

test('filterTsv: CRLF 改行の入力も分割して処理する', () => {
  const input = [HEADER, row('a', 'X'), row('b', 'Y')].join('\r\n');

  const out = filterTsv(input, '種別', 'X').tsv.split('\n');

  assert.strictEqual(out.length, 2);
  assert.ok(out.some((line) => line.startsWith('b\t')));
});

test('filterTsv: 空行はスキップし、末尾改行があっても壊れない', () => {
  const input = [HEADER, row('a', 'X'), '', row('b', 'Y'), ''].join('\n');

  const out = filterTsv(input, '種別', 'X').tsv.split('\n');

  assert.strictEqual(out.length, 2, 'ヘッダー + 残り1行');
  assert.ok(out.some((line) => line.startsWith('b\t')));
});

test('filterTsv: 読込・出力・除外の件数を返す（ヘッダと空行は読込件数に数えない）', () => {
  // stderr サマリ用の件数。空行はスキップされ read に含めない
  const input = [HEADER, row('a', 'X'), row('b', 'Y'), '', row('c', 'X')].join('\n');

  const result = filterTsv(input, '種別', 'X');

  assert.strictEqual(result.read, 3, 'データ行は3（空行は除く）');
  assert.strictEqual(result.kept, 1, '残るのは Y の1行');
  assert.strictEqual(result.excluded, 2, '除外は X の2行');
});

test('filterTsv: 存在しないヘッダ名を指定すると例外を投げる', () => {
  const input = [HEADER, row('a', 'X')].join('\n');

  assert.throws(() => filterTsv(input, '存在しない列', 'X'), /列が見つかりません/);
});

test('filterTsv: 範囲外の列番号を指定すると例外を投げる', () => {
  const input = [HEADER, row('a', 'X')].join('\n');

  assert.throws(() => filterTsv(input, '99', 'X'), /列が見つかりません/);
});

test('filterTsv: 列番号は 1始まりなので 0 は無効（例外を投げる）', () => {
  const input = [HEADER, row('a', 'X')].join('\n');

  assert.throws(() => filterTsv(input, '0', 'X'), /列が見つかりません/);
});

test('filterTsv: 空入力は空文字と件数0を返す', () => {
  const result = filterTsv('', '種別', 'X');

  assert.strictEqual(result.tsv, '');
  assert.strictEqual(result.read, 0);
  assert.strictEqual(result.kept, 0);
  assert.strictEqual(result.excluded, 0);
});
