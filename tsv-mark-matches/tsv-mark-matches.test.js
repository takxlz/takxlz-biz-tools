'use strict';

// テスト名を仕様文として読めるようにしている（入力条件 → 期待結果）。
// 各テスト本体は「準備 → 実行 → 検証(assert)」の順。非自明な意図のみコメントで補う。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getBaseName,
  parseFileList,
  resolveMatchColumnIndex,
  markHeaderLine,
  markDataLine,
  markMatches,
  markMatchesStream,
} = require('./tsv-mark-matches');

// ---- getBaseName: パスの末尾セグメントを取り出す ----------------------------

test('getBaseName: POSIX パス（/ 区切り）は末尾セグメントを返す', () => {
  assert.strictEqual(getBaseName('src/main/app.properties'), 'app.properties');
});

test('getBaseName: Windows パス（\\ 区切り）も末尾セグメントを返す', () => {
  assert.strictEqual(getBaseName('src\\main\\app.properties'), 'app.properties');
});

test('getBaseName: 区切りを含まない値はそのまま返す', () => {
  assert.strictEqual(getBaseName('app.properties'), 'app.properties');
});

// ---- parseFileList: 1行1ファイル名のテキストを配列にする ---------------------

test('parseFileList: 各行をトリムし、空行・空白のみの行を除外する', () => {
  const listText = 'a.properties\n  b.properties  \n\n\tc.properties\n';

  assert.deepStrictEqual(parseFileList(listText), [
    'a.properties',
    'b.properties',
    'c.properties',
  ]);
});

test('parseFileList: CRLF 改行を分割し、末尾に \\r を残さない', () => {
  assert.deepStrictEqual(parseFileList('a.txt\r\nb.txt\r\n'), ['a.txt', 'b.txt']);
});

// ---- resolveMatchColumnIndex: マッチ対象列の 0始まりインデックスを解決 -------

const HEADER = ['file', 'key', '種別', 'dev', 'prd', 'description'];

test('resolveMatchColumnIndex: 未指定（undefined / 空文字）なら最左列を返す', () => {
  assert.strictEqual(resolveMatchColumnIndex(HEADER, undefined), 0);
  assert.strictEqual(resolveMatchColumnIndex(HEADER, ''), 0);
});

test('resolveMatchColumnIndex: ヘッダ名に一致する列を返す', () => {
  assert.strictEqual(resolveMatchColumnIndex(HEADER, 'file'), 0);
  assert.strictEqual(resolveMatchColumnIndex(HEADER, '種別'), 2);
});

test('resolveMatchColumnIndex: 1始まりの列番号を 0始まりインデックスに変換する', () => {
  assert.strictEqual(resolveMatchColumnIndex(HEADER, '1'), 0);
  assert.strictEqual(resolveMatchColumnIndex(HEADER, 4), 3);
});

test('resolveMatchColumnIndex: 同じ綴りならヘッダ名を列番号より優先する', () => {
  // ヘッダに "1" という名前の列があれば「列番号1」ではなく「名前 1」として解決する
  assert.strictEqual(resolveMatchColumnIndex(['1', 'file'], '1'), 0);
});

test('resolveMatchColumnIndex: 範囲外（上限超え / 0以下）の列番号は例外を投げる', () => {
  assert.throws(() => resolveMatchColumnIndex(HEADER, '7'), /範囲外/);
  assert.throws(() => resolveMatchColumnIndex(HEADER, '0'), /範囲外/);
});

test('resolveMatchColumnIndex: 名前にも番号にも該当しない指定は例外を投げる', () => {
  // 黙って最左列にフォールバックせず、指定ミスを顕在化させる
  assert.throws(() => resolveMatchColumnIndex(HEADER, 'nope'), /見つかりません/);
});

// ---- markHeaderLine: ヘッダ末尾に新規列を足す --------------------------------

test('markHeaderLine: ヘッダ末尾に新規列名をタブ区切りで追加する', () => {
  assert.strictEqual(
    markHeaderLine('file\tkey\t種別\tdev\tprd\tdescription', 'match'),
    'file\tkey\t種別\tdev\tprd\tdescription\tmatch'
  );
});

// ---- markDataLine: 対象列の basename 完全一致で印を付ける --------------------

test('markDataLine: 対象列の basename がリストに一致したら末尾に印を付ける', () => {
  const fileNameSet = new Set(['app.properties']);

  assert.strictEqual(
    markDataLine('src/main/app.properties\tk\t種別\tv\t説明', fileNameSet, '●', 0),
    'src/main/app.properties\tk\t種別\tv\t説明\t●'
  );
});

test('markDataLine: 非一致なら末尾に空セルを付けて列数を揃える', () => {
  const fileNameSet = new Set(['app.properties']);

  assert.strictEqual(
    markDataLine('src/main/other.properties\tk\t種別\tv\t説明', fileNameSet, '●', 0),
    'src/main/other.properties\tk\t種別\tv\t説明\t'
  );
});

test('markDataLine: basename 完全一致のみ（接頭辞違いの myapp.properties は非一致）', () => {
  // 「後方一致」を単純な文字列 endsWith で実装すると myapp.properties を誤検出する。その回帰防止。
  const fileNameSet = new Set(['app.properties']);

  assert.strictEqual(
    markDataLine('src/myapp.properties\tk\t種別\tv\t説明', fileNameSet, '●', 0),
    'src/myapp.properties\tk\t種別\tv\t説明\t'
  );
});

test('markDataLine: 先頭以外の列（matchIndex 指定）でも判定する', () => {
  const fileNameSet = new Set(['app.properties']);

  // 4列目（index=3）にパスがあるケース
  assert.strictEqual(
    markDataLine('k\t種別\tv\tconf/app.properties\t説明', fileNameSet, '●', 3),
    'k\t種別\tv\tconf/app.properties\t説明\t●'
  );
});

test('markDataLine: Windows パス（\\ 区切り）でも basename で判定する', () => {
  const fileNameSet = new Set(['app.properties']);

  assert.strictEqual(
    markDataLine('conf\\app.properties\tk\t種別\tv\t説明', fileNameSet, '●', 0),
    'conf\\app.properties\tk\t種別\tv\t説明\t●'
  );
});

test('markDataLine: 対象列セルの前後空白は無視して判定する（元の行は変えない）', () => {
  const fileNameSet = new Set(['app.properties']);

  assert.strictEqual(
    markDataLine('  conf/app.properties  \tk\t種別\tv\t説明', fileNameSet, '●', 0),
    '  conf/app.properties  \tk\t種別\tv\t説明\t●'
  );
});

test('markDataLine: 列数不足で対象列が無い行は非一致扱い（例外にしない）', () => {
  const fileNameSet = new Set(['app.properties']);

  assert.strictEqual(markDataLine('a\tb', fileNameSet, '●', 5), 'a\tb\t');
});

test('markDataLine: 空行は変更せずそのまま返す', () => {
  assert.strictEqual(markDataLine('', new Set(['a']), '●', 0), '');
});

// ---- markMatches: TSV 全体（ヘッダ＋データ行）を処理する ----------------------

test('markMatches: matchCol 未指定なら最左列で判定する', () => {
  const tsv = [
    'path\t種別\tkey',
    'src/a.properties\t型\tk1',
    'src/b.properties\t型\tk2',
  ].join('\n');

  assert.strictEqual(
    markMatches(tsv, ['a.properties']),
    [
      'path\t種別\tkey\tmatch',
      'src/a.properties\t型\tk1\t●',
      'src/b.properties\t型\tk2\t',
    ].join('\n')
  );
});

test('markMatches: matchCol にヘッダ名を指定して判定する（env 列が複数あっても無関係）', () => {
  const tsv = [
    'file\tkey\t種別\tdev\tprd\tdescription',
    'src/a.properties\tk1\t文字列\tv1\tw1\t説明1',
    'src/b.properties\tk2\t数値\tv2\tw2\t説明2',
  ].join('\n');

  assert.strictEqual(
    markMatches(tsv, ['a.properties'], { matchCol: 'file' }),
    [
      'file\tkey\t種別\tdev\tprd\tdescription\tmatch',
      'src/a.properties\tk1\t文字列\tv1\tw1\t説明1\t●',
      'src/b.properties\tk2\t数値\tv2\tw2\t説明2\t',
    ].join('\n')
  );
});

test('markMatches: matchCol に列番号（1始まり）を指定すると同じ列で判定する', () => {
  const tsv = [
    'file\tkey\tdescription',
    'src/a.properties\tk1\t説明1',
    'src/b.properties\tk2\t説明2',
  ].join('\n');

  assert.strictEqual(
    markMatches(tsv, ['a.properties'], { matchCol: 1 }),
    [
      'file\tkey\tdescription\tmatch',
      'src/a.properties\tk1\t説明1\t●',
      'src/b.properties\tk2\t説明2\t',
    ].join('\n')
  );
});

test('markMatches: 入力末尾の改行を出力でも保持する', () => {
  const tsv = 'file\tkey\tdescription\nsrc/a.properties\tk\t説明\n';

  const result = markMatches(tsv, ['a.properties'], { matchCol: 'file' });

  assert.ok(result.endsWith('\n'));
  assert.strictEqual(result, 'file\tkey\tdescription\tmatch\nsrc/a.properties\tk\t説明\t●\n');
});

test('markMatches: columnHeader と mark を上書きできる', () => {
  const tsv = 'file\tdescription\nsrc/a.properties\t説明';

  const result = markMatches(tsv, ['a.properties'], {
    matchCol: 'file',
    columnHeader: '一致',
    mark: 'X',
  });

  assert.strictEqual(result, 'file\tdescription\t一致\nsrc/a.properties\t説明\tX');
});

// ---- markMatchesStream: ファイル入出力（大きめの入力向けストリーム処理） -----

test('markMatchesStream: ファイルを1行ずつ処理し、印付きTSVを書き出す', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv-mark-'));
  const inputPath = path.join(tmpDir, 'in.tsv');
  const outputPath = path.join(tmpDir, 'out.tsv');
  fs.writeFileSync(
    inputPath,
    [
      'file\tkey\t種別\tdev\tdescription',
      'a/app.properties\tk1\t型\tv1\t説明1',
      'a/other.properties\tk2\t型\tv2\t説明2',
    ].join('\n') + '\n'
  );

  const outStream = fs.createWriteStream(outputPath);
  await markMatchesStream(inputPath, new Set(['app.properties']), outStream, { matchCol: 'file' });
  await new Promise((resolve) => outStream.end(resolve));

  // インメモリ版（markMatches）と同じ結果になり、末尾改行も保持されること
  assert.strictEqual(
    fs.readFileSync(outputPath, 'utf8'),
    [
      'file\tkey\t種別\tdev\tdescription\tmatch',
      'a/app.properties\tk1\t型\tv1\t説明1\t●',
      'a/other.properties\tk2\t型\tv2\t説明2\t',
    ].join('\n') + '\n'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('markMatchesStream: 読込データ行数と一致行数を返す（ヘッダ・空行は数えない）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv-mark-'));
  const inputPath = path.join(tmpDir, 'in.tsv');
  fs.writeFileSync(
    inputPath,
    [
      'file\tkey',
      'a/app.properties\tk1', // 一致
      'a/other.properties\tk2', // 非一致
      '', // 空行は数えない
      'b/db.properties\tk3', // 一致
    ].join('\n') + '\n'
  );

  // 出力先は捨てる（戻り値の件数だけを検証する）
  const sink = fs.createWriteStream(path.join(tmpDir, 'out.tsv'));
  const stats = await markMatchesStream(
    inputPath,
    new Set(['app.properties', 'db.properties']),
    sink,
    { matchCol: 'file' }
  );
  await new Promise((resolve) => sink.end(resolve));

  assert.strictEqual(stats.rowCount, 3, 'データ行は3（空行は除く）');
  assert.strictEqual(stats.matchedCount, 2, '一致は app/db の2行');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
